import dns from 'dns';
import net from 'net';
import tls from 'tls';
import chalk from 'chalk';
import { generateProxyProtocolV2Header } from './proxyProtocolBuilder.js';
import { getOriginalClientFromHeaders, parseProxyV2Chain } from './proxyProtocolParser.js';
import { getBufferPreview } from './logPreview.js';
import { getHttpRequestPath, isLikelyHttpRequest, rewriteHttpRequest, rewriteHttpResponse } from './httpProxyRewrite.js';
import { getHttpMappedTargetsForPath, getTargetsForProtocol } from './proxyConfig.js';
import { resolveListenerTlsCredentials } from './tlsConfig.js';
import type { ListenerRule, ProxyTarget } from './proxyTypes.js';
import type { ProxyRuntime } from './proxyRuntime.js';

const CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_CLIENT_DATA_TIMEOUT_MS = 30_000;

export function startTcpProxy(rule: ListenerRule, runtime: ProxyRuntime) {
  const tcpTargets = getTargetsForProtocol(rule, 'tcp');
  const hasHttpMappings = Array.isArray(rule.httpMappings)
    && rule.httpMappings.some((mapping) => {
      const mappingTargets = Array.isArray(mapping.targets) && mapping.targets.length > 0
        ? mapping.targets
        : [mapping.target];
      return mappingTargets.some((target) => target.tcp !== undefined);
    });
  if (rule.tcp === undefined || (tcpTargets.length === 0 && !hasHttpMappings)) {
    return;
  }

  const bindAddr = rule.bind || '0.0.0.0';
  const listenerProto: 'http' | 'https' = rule.https?.enabled ? 'https' : 'http';
  const tlsCredentials = resolveListenerTlsCredentials(rule.https);
  const handleClientSocket = (clientSocket: net.Socket | tls.TLSSocket) => {
    const debugLog = (...args: unknown[]) => {
      if (runtime.debug) {
        console.log(...args);
      }
    };

    runtime.connectionStats.tcp.total++;
    runtime.connectionStats.tcp.active++;

    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    let proxyIP = clientSocket.remoteAddress || '0.0.0.0';
    let proxyPort = clientSocket.remotePort || 0;
    let selectedTcpTargets = tcpTargets;
    let activeTarget = selectedTcpTargets[0] ?? rule.target;
    let targetStr = `${activeTarget.host}:${activeTarget.tcp}`;
    let destSocket: net.Socket | tls.TLSSocket | null = null;
    let destConnected = false;
    let initialDataSeen = false;
    let webhookSentForConn = false;
    let clientToServerBytes = 0;
    let serverToClientBytes = 0;
    let isFinalized = false;
    let clientClosed = false;
    let targetClosed = false;
    let clientToTargetBlocked = false;
    let targetToClientBlocked = false;
    let prefaceSent = false;
    let prefaceBuffer: Buffer | null = null;
    let prefacePayloadBytes = 0;
    let initialHttpRequestRewritten = false;
    let responseHeadHandled = false;
    let pendingTargetResponseChunks: Buffer[] = [];
    let clientChunkLogCount = 0;
    let serverChunkLogCount = 0;
    const pendingClientChunks: Buffer[] = [];
    const pendingConnectTimers = new Set<ReturnType<typeof setTimeout>>();

    const initialDataTimer = setTimeout(() => {
      if (isFinalized || initialDataSeen) {
        return;
      }
      console.error(chalk.red(`[TCP] ✗ No initial data within ${INITIAL_CLIENT_DATA_TIMEOUT_MS}ms from ${clientAddr}`));
      abortConnection();
    }, INITIAL_CLIENT_DATA_TIMEOUT_MS);

    const logClientChunk = (label: string, chunk: Buffer) => {
      if (clientChunkLogCount < 5) {
        debugLog(chalk.gray(`[TCP] ${label} ${getBufferPreview(chunk)}`));
      } else if (clientChunkLogCount === 5) {
        debugLog(chalk.gray(`[TCP] Additional client->target chunk logs suppressed for ${clientAddr}`));
      }
      clientChunkLogCount++;
    };

    const logServerChunk = (label: string, chunk: Buffer) => {
      if (serverChunkLogCount < 5) {
        debugLog(chalk.gray(`[TCP] ${label} ${getBufferPreview(chunk)}`));
      } else if (serverChunkLogCount === 5) {
        debugLog(chalk.gray(`[TCP] Additional target->client chunk logs suppressed for ${clientAddr}`));
      }
      serverChunkLogCount++;
    };

    const clearAllTimers = () => {
      clearTimeout(initialDataTimer);
      for (const timer of pendingConnectTimers) {
        clearTimeout(timer);
      }
      pendingConnectTimers.clear();
    };

    const finalizeConnection = () => {
      if (isFinalized) {
        return;
      }

      if (!clientClosed || !targetClosed) {
        return;
      }

      isFinalized = true;
      clearAllTimers();
      runtime.connectionStats.tcp.active--;
      debugLog(chalk.yellow(`[TCP] Connection closed ${clientAddr} (sent: ${clientToServerBytes}B, recv: ${serverToClientBytes}B)`));
    };

    const abortConnection = () => {
      if (isFinalized) {
        return;
      }

      isFinalized = true;
      clearAllTimers();
      runtime.connectionStats.tcp.active--;

      if (destSocket && !destSocket.destroyed) {
        destSocket.destroy();
      }
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }

      if (destConnected) {
        debugLog(chalk.yellow(`[TCP] Connection closed ${clientAddr} (sent: ${clientToServerBytes}B, recv: ${serverToClientBytes}B)`));
      } else {
        console.log(chalk.red(`[TCP] Connection failed ${clientAddr} => ${targetStr}`));
      }
    };

    const flushClientToTarget = () => {
      if (isFinalized || !destSocket || !destConnected || clientToTargetBlocked) {
        return;
      }

      if (!prefaceSent) {
        if (prefaceBuffer) {
          const flushed = destSocket.write(prefaceBuffer);
          clientToServerBytes += prefacePayloadBytes;
          prefacePayloadBytes = 0;
          prefaceSent = true;
          if (!flushed) {
            clientToTargetBlocked = true;
            if (!clientSocket.destroyed) {
              clientSocket.pause();
            }
            debugLog(chalk.gray(`[TCP] Target socket backpressure for ${clientAddr}; pausing client reads`));
            return;
          }
        } else {
          prefaceSent = true;
        }
      }

      while (pendingClientChunks.length > 0 && !clientToTargetBlocked) {
        const chunk = pendingClientChunks.shift()!;
        clientToServerBytes += chunk.length;
        const flushed = destSocket.write(chunk);
        if (!flushed) {
          clientToTargetBlocked = true;
          if (!clientSocket.destroyed) {
            clientSocket.pause();
          }
          debugLog(chalk.gray(`[TCP] Target socket backpressure for ${clientAddr}; pausing client reads`));
          break;
        }
      }
    };

    const maybeRewriteClientRequest = (chunk: Buffer) => {
      if (!activeTarget.urlProtocol || !isLikelyHttpRequest(chunk)) {
        return chunk;
      }

      const rewritten = rewriteHttpRequest(chunk, activeTarget, listenerProto);
      if (!rewritten.equals(chunk)) {
        debugLog(chalk.blue(`[TCP] Rewrote HTTP request for ${activeTarget.originalUrl ?? activeTarget.host}`));
      }
      return rewritten;
    };

    const queueClientChunk = (chunk: Buffer, label: string) => {
      if (chunk.length === 0 || isFinalized) {
        return;
      }

      const outgoingChunk = maybeRewriteClientRequest(chunk);
      logClientChunk(label, outgoingChunk);
      pendingClientChunks.push(outgoingChunk);
      flushClientToTarget();
    };

    const maybeNotifyConnect = () => {
      if (webhookSentForConn || !rule.webhook || rule.webhook.trim() === '') {
        return;
      }

      webhookSentForConn = true;
      if (runtime.useRestApi) {
        runtime.connectionBuffer.addPending(proxyIP, proxyPort, 'TCP', targetStr, () => {});
      } else {
        runtime.groupedNotifier.addConnectGroup(rule.webhook, targetStr, proxyIP, proxyPort, 'TCP');
      }
    };

    const maybeRewriteTargetResponse = (chunk: Buffer) => {
      if (!activeTarget.urlProtocol || responseHeadHandled) {
        return [chunk];
      }

      pendingTargetResponseChunks.push(chunk);
      const combined = Buffer.concat(pendingTargetResponseChunks);
      const headerEnd = combined.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return [] as Buffer[];
      }

      responseHeadHandled = true;
      pendingTargetResponseChunks = [];
      return [rewriteHttpResponse(combined, activeTarget)];
    };

    const armTargetToClientForwarding = (socket: net.Socket | tls.TLSSocket) => {
      socket.on('data', (rawChunk) => {
        if (isFinalized) {
          return;
        }

        for (const chunk of maybeRewriteTargetResponse(rawChunk)) {
          serverToClientBytes += chunk.length;
          logServerChunk('Target -> client chunk', chunk);
          const flushed = clientSocket.write(chunk);
          if (!flushed) {
            targetToClientBlocked = true;
            socket.pause();
            debugLog(chalk.gray(`[TCP] Client socket backpressure while sending to ${clientAddr}; pausing target reads`));
            break;
          }
        }
      });

      clientSocket.on('drain', () => {
        if (!targetToClientBlocked || socket.destroyed || isFinalized) {
          return;
        }
        targetToClientBlocked = false;
        socket.resume();
        debugLog(chalk.gray(`[TCP] Client socket drain for ${clientAddr}; resumed target reads`));
      });

      socket.on('drain', () => {
        if (!clientToTargetBlocked || clientSocket.destroyed || isFinalized) {
          return;
        }
        clientToTargetBlocked = false;
        clientSocket.resume();
        debugLog(chalk.gray(`[TCP] Target socket drain for ${clientAddr}; resumed client reads`));
        flushClientToTarget();
      });

      debugLog(chalk.gray(`[TCP] Target -> client piping armed for ${clientAddr}`));
    };

    const preparePreface = async (target: ProxyTarget) => {
      const bufferedBeforeConnect = pendingClientChunks.splice(0, pendingClientChunks.length);
      prefacePayloadBytes = bufferedBeforeConnect.reduce((sum, chunk) => sum + chunk.length, 0);

      if (!rule.haproxy) {
        prefaceBuffer = bufferedBeforeConnect.length > 0 ? Buffer.concat(bufferedBeforeConnect) : null;
        if (prefaceBuffer) {
          prefacePayloadBytes = prefaceBuffer.length;
        }
        return;
      }

      const destPort = target.tcp || 0;
      let destIP = target.host;

      try {
        if (net.isIP(destIP) === 0) {
          const addr = await dns.promises.lookup(destIP);
          destIP = addr.address;
          debugLog(chalk.dim(`[TCP] Resolved ${target.host} to ${destIP}`));
        }
      } catch (err) {
        console.warn(
          chalk.yellow('[TCP] Failed to resolve destination host, using original host'),
          err instanceof Error ? err.message : String(err),
        );
      }

      const header = generateProxyProtocolV2Header(proxyIP, proxyPort, destIP, destPort, false);
      debugLog(chalk.blue(`[TCP] Sending PROXY header (${header.length} bytes) to ${destIP}:${destPort}`));
      debugLog(chalk.gray(`[TCP] PROXY header preview ${getBufferPreview(header)}`));
      prefaceBuffer = bufferedBeforeConnect.length > 0
        ? Buffer.concat([header, ...bufferedBeforeConnect])
        : header;
    };

    const connectToTarget = (targetIndex: number) => {
      if (isFinalized) {
        return;
      }

      if (targetIndex >= selectedTcpTargets.length) {
        console.error(chalk.red(`[TCP] ✗ All targets failed for ${clientAddr}`));
        abortConnection();
        return;
      }

      activeTarget = selectedTcpTargets[targetIndex];
      targetStr = `${activeTarget.host}:${activeTarget.tcp}`;
      responseHeadHandled = false;
      pendingTargetResponseChunks = [];
      initialHttpRequestRewritten = false;
      debugLog(chalk.cyan(`[TCP] Establishing connection: ${proxyIP}:${proxyPort} => ${targetStr} (${targetIndex + 1}/${selectedTcpTargets.length})`));

      const currentSocket = activeTarget.urlProtocol === 'https'
        ? tls.connect({
            host: activeTarget.host,
            port: activeTarget.tcp!,
            servername: activeTarget.host,
          })
        : net.createConnection({
            host: activeTarget.host,
            port: activeTarget.tcp!,
          });
      destSocket = currentSocket;
      debugLog(chalk.gray(`[TCP] Created destination socket for ${targetStr}`));
      currentSocket.setKeepAlive(true, 30_000);
      currentSocket.setNoDelay(true);
      clientSocket.setKeepAlive(true, 30_000);
      clientSocket.setNoDelay(true);

      let settled = false;
      const connectTimer = setTimeout(() => {
        if (isFinalized || settled || destConnected) {
          return;
        }
        settled = true;
        console.error(chalk.red(`[TCP] ✗ Destination connect timeout ${targetStr}`));
        currentSocket.destroy();
        if (targetIndex + 1 < selectedTcpTargets.length) {
          debugLog(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
          connectToTarget(targetIndex + 1);
        } else {
          abortConnection();
        }
      }, CONNECT_TIMEOUT_MS);
      pendingConnectTimers.add(connectTimer);

      currentSocket.on('connect', async () => {
        if (settled || isFinalized) {
          return;
        }

        settled = true;
        pendingConnectTimers.delete(connectTimer);
        clearTimeout(connectTimer);
        destConnected = true;
        currentSocket.setTimeout(0);
        debugLog(chalk.green(`[TCP] ✓ Connected to target ${targetStr}`));
        debugLog(chalk.gray(`[TCP] Destination socket local endpoint ${currentSocket.localAddress}:${currentSocket.localPort}`));
        armTargetToClientForwarding(currentSocket);

        try {
          await preparePreface(activeTarget);
          if (prefacePayloadBytes > 0) {
            debugLog(chalk.dim(`[TCP] Forwarding initial data (${prefacePayloadBytes} bytes buffered)`));
          }
          flushClientToTarget();
          debugLog(chalk.gray(`[TCP] Client -> target pump armed for ${clientAddr}`));
          debugLog(chalk.green(`[TCP] ✓ Piping established for ${clientAddr}`));
          maybeNotifyConnect();
        } catch (err) {
          console.error(chalk.red('[TCP] Error during connection setup:'), err instanceof Error ? err.message : String(err));
          abortConnection();
        }
      });

      currentSocket.on('error', (err: Error) => {
        pendingConnectTimers.delete(connectTimer);
        clearTimeout(connectTimer);
        if (!settled && !destConnected && !isFinalized) {
          settled = true;
          console.error(chalk.red(`[TCP] ✗ Destination socket error ${targetStr}:`), err.message);
          if (targetIndex + 1 < selectedTcpTargets.length) {
            debugLog(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
            connectToTarget(targetIndex + 1);
          } else {
            abortConnection();
          }
          return;
        }

        if (!isFinalized) {
          console.error(chalk.red(`[TCP] ✗ Destination socket error ${targetStr}:`), err.message);
          abortConnection();
        }
      });

      currentSocket.on('timeout', () => {
        pendingConnectTimers.delete(connectTimer);
        clearTimeout(connectTimer);
        if (!isFinalized) {
          console.error(chalk.red(`[TCP] ✗ Destination socket timeout ${targetStr}`));
          abortConnection();
        }
      });

      currentSocket.on('end', () => {
        debugLog(chalk.gray(`[TCP] Destination socket ended ${targetStr}`));
        if (!clientSocket.destroyed && !clientSocket.writableEnded) {
          clientSocket.end();
        }
      });

      currentSocket.on('close', () => {
        pendingConnectTimers.delete(connectTimer);
        clearTimeout(connectTimer);

        if (!settled && !destConnected && !isFinalized) {
          settled = true;
          if (targetIndex + 1 < selectedTcpTargets.length) {
            debugLog(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
            connectToTarget(targetIndex + 1);
          } else {
            abortConnection();
          }
          return;
        }

        targetClosed = true;
        if (!isFinalized) {
          debugLog(chalk.dim(`[TCP] Destination socket closed ${targetStr}`));
          finalizeConnection();
        }
      });
    };

    clientSocket.on('data', (chunk) => {
      if (isFinalized) {
        return;
      }

      if (!initialDataSeen) {
        initialDataSeen = true;
        clearTimeout(initialDataTimer);
        debugLog(chalk.gray(`[TCP] Initial client data ${getBufferPreview(chunk)}`));

        let initialPayload: Buffer = Buffer.from(chunk);
        if (chunk.length > 16) {
          try {
            const chain = parseProxyV2Chain(chunk);
            if (chain.headers.length > 0) {
              const original = getOriginalClientFromHeaders(chain.headers);
              if (original) {
                proxyIP = original.ip || proxyIP;
                proxyPort = original.port || proxyPort;
              }
              initialPayload = Buffer.from(chain.payload);
              if (initialPayload.length > 0) {
                debugLog(chalk.gray(`[TCP] Initial payload after PROXY strip ${getBufferPreview(initialPayload)}`));
              } else {
                debugLog(chalk.gray('[TCP] Initial payload after PROXY strip is empty'));
              }
              debugLog(chalk.cyan('[TCP] Parsed proxy chain:'), {
                layers: chain.headers.length,
                original: `${proxyIP}:${proxyPort}`,
              });
            }
          } catch {
            // Treat as raw application payload.
          }
        }

        const mappedTargets = getHttpMappedTargetsForPath(
          rule,
          'tcp',
          getHttpRequestPath(initialPayload),
        );
        selectedTcpTargets = mappedTargets.length > 0 ? mappedTargets : tcpTargets;
        if (selectedTcpTargets.length === 0) {
          console.error(chalk.red(`[TCP] ✗ No TCP target matched initial request from ${clientAddr}`));
          abortConnection();
          return;
        }
        activeTarget = selectedTcpTargets[0];

        debugLog(chalk.dim(`[TCP] Incoming connection from ${clientAddr} => ${selectedTcpTargets.map((target) => `${target.host}:${target.tcp}`).join(' -> ')}`));

        if (initialPayload.length > 0) {
          queueClientChunk(initialPayload, 'Initial payload -> target');
        }

        connectToTarget(0);
        return;
      }

      queueClientChunk(chunk, 'Client -> target live chunk');
    });

    clientSocket.on('error', (err: Error) => {
      clearTimeout(initialDataTimer);
      console.error(chalk.red('[TCP] Client socket error:'), err.message);
      abortConnection();
    });

    clientSocket.on('timeout', () => {
      clearTimeout(initialDataTimer);
      console.error(chalk.red('[TCP] Client socket timeout'));
      abortConnection();
    });

    clientSocket.on('end', () => {
      clearTimeout(initialDataTimer);
      debugLog(chalk.gray(`[TCP] Client socket ended ${clientAddr}`));
      if (destSocket && !destSocket.destroyed && !destSocket.writableEnded) {
        destSocket.end();
      }
    });

    clientSocket.on('close', () => {
      clearTimeout(initialDataTimer);
      clientClosed = true;
      debugLog(chalk.gray(`[TCP] Client socket closed ${clientAddr}`));

      if (!destConnected && !isFinalized) {
        abortConnection();
        return;
      }

      finalizeConnection();
    });
  };

  const server = tlsCredentials
    ? tls.createServer({
        cert: tlsCredentials.cert,
        key: tlsCredentials.key,
      }, handleClientSocket)
    : net.createServer(handleClientSocket);

  if (tlsCredentials) {
    server.on('tlsClientError', (err: Error) => {
      console.error(chalk.red('[TCP] TLS client error:'), err.message);
    });
    console.log(chalk.green(`[TCP] HTTPS enabled on ${bindAddr}:${rule.tcp}`));
    if (runtime.debug) {
      console.log(chalk.gray(`[TCP] TLS credentials: ${tlsCredentials.source} (${tlsCredentials.certPath}, ${tlsCredentials.keyPath})`));
    }
  }

  server.on('error', (err: Error) => {
    console.error(chalk.red('[TCP] Server error:'), err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') {
      console.error(chalk.red(`[TCP]   → Permission denied on ${bindAddr}:${rule.tcp}. Privileged ports (e.g. 80/443) may require elevated privileges.`));
    } else if (code === 'EADDRINUSE') {
      console.error(chalk.red(`[TCP]   → ${bindAddr}:${rule.tcp} is already in use by another process.`));
    }
  });

  server.listen(rule.tcp, bindAddr);
}
