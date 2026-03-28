import dns from 'dns';
import net from 'net';
import chalk from 'chalk';
import { generateProxyProtocolV2Header } from './proxyProtocolBuilder.js';
import { getOriginalClientFromHeaders, parseProxyV2Chain } from './proxyProtocolParser.js';
import { getBufferPreview } from './logPreview.js';
import { getTargetsForProtocol } from './proxyConfig.js';
import type { ListenerRule, ProxyTarget } from './proxyTypes.js';
import type { ProxyRuntime } from './proxyRuntime.js';

const CONNECT_TIMEOUT_MS = 10_000;
const INITIAL_CLIENT_DATA_TIMEOUT_MS = 30_000;

export function startTcpProxy(rule: ListenerRule, runtime: ProxyRuntime) {
  const tcpTargets = getTargetsForProtocol(rule, 'tcp');
  if (rule.tcp === undefined || tcpTargets.length === 0) {
    return;
  }

  const bindAddr = rule.bind || '0.0.0.0';
  const server = net.createServer((clientSocket) => {
    runtime.connectionStats.tcp.total++;
    runtime.connectionStats.tcp.active++;

    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    let proxyIP = clientSocket.remoteAddress || '0.0.0.0';
    let proxyPort = clientSocket.remotePort || 0;
    let activeTarget = tcpTargets[0];
    let targetStr = `${activeTarget.host}:${activeTarget.tcp}`;
    let destSocket: net.Socket | null = null;
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
        console.log(chalk.gray(`[TCP] ${label} ${getBufferPreview(chunk)}`));
      } else if (clientChunkLogCount === 5) {
        console.log(chalk.gray(`[TCP] Additional client->target chunk logs suppressed for ${clientAddr}`));
      }
      clientChunkLogCount++;
    };

    const logServerChunk = (label: string, chunk: Buffer) => {
      if (serverChunkLogCount < 5) {
        console.log(chalk.gray(`[TCP] ${label} ${getBufferPreview(chunk)}`));
      } else if (serverChunkLogCount === 5) {
        console.log(chalk.gray(`[TCP] Additional target->client chunk logs suppressed for ${clientAddr}`));
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
      console.log(chalk.yellow(`[TCP] Connection closed ${clientAddr} (sent: ${clientToServerBytes}B, recv: ${serverToClientBytes}B)`));
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
        console.log(chalk.yellow(`[TCP] Connection closed ${clientAddr} (sent: ${clientToServerBytes}B, recv: ${serverToClientBytes}B)`));
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
            console.log(chalk.gray(`[TCP] Target socket backpressure for ${clientAddr}; pausing client reads`));
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
          console.log(chalk.gray(`[TCP] Target socket backpressure for ${clientAddr}; pausing client reads`));
          break;
        }
      }
    };

    const queueClientChunk = (chunk: Buffer, label: string) => {
      if (chunk.length === 0 || isFinalized) {
        return;
      }

      logClientChunk(label, chunk);
      pendingClientChunks.push(chunk);
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

    const armTargetToClientForwarding = (socket: net.Socket) => {
      socket.on('data', (chunk) => {
        if (isFinalized) {
          return;
        }

        serverToClientBytes += chunk.length;
        logServerChunk('Target -> client chunk', chunk);
        const flushed = clientSocket.write(chunk);
        if (!flushed) {
          targetToClientBlocked = true;
          socket.pause();
          console.log(chalk.gray(`[TCP] Client socket backpressure while sending to ${clientAddr}; pausing target reads`));
        }
      });

      clientSocket.on('drain', () => {
        if (!targetToClientBlocked || socket.destroyed || isFinalized) {
          return;
        }
        targetToClientBlocked = false;
        socket.resume();
        console.log(chalk.gray(`[TCP] Client socket drain for ${clientAddr}; resumed target reads`));
      });

      socket.on('drain', () => {
        if (!clientToTargetBlocked || clientSocket.destroyed || isFinalized) {
          return;
        }
        clientToTargetBlocked = false;
        clientSocket.resume();
        console.log(chalk.gray(`[TCP] Target socket drain for ${clientAddr}; resumed client reads`));
        flushClientToTarget();
      });

      console.log(chalk.gray(`[TCP] Target -> client piping armed for ${clientAddr}`));
    };

    const preparePreface = async (target: ProxyTarget) => {
      const bufferedBeforeConnect = pendingClientChunks.splice(0, pendingClientChunks.length);
      prefacePayloadBytes = bufferedBeforeConnect.reduce((sum, chunk) => sum + chunk.length, 0);

      if (!rule.haproxy) {
        prefaceBuffer = bufferedBeforeConnect.length > 0 ? Buffer.concat(bufferedBeforeConnect) : null;
        return;
      }

      const destPort = target.tcp || 0;
      let destIP = target.host;

      try {
        if (net.isIP(destIP) === 0) {
          const addr = await dns.promises.lookup(destIP);
          destIP = addr.address;
          console.log(chalk.dim(`[TCP] Resolved ${target.host} to ${destIP}`));
        }
      } catch (err) {
        console.warn(
          chalk.yellow('[TCP] Failed to resolve destination host, using original host'),
          err instanceof Error ? err.message : String(err),
        );
      }

      const header = generateProxyProtocolV2Header(proxyIP, proxyPort, destIP, destPort, false);
      console.log(chalk.blue(`[TCP] Sending PROXY header (${header.length} bytes) to ${destIP}:${destPort}`));
      console.log(chalk.gray(`[TCP] PROXY header preview ${getBufferPreview(header)}`));
      prefaceBuffer = bufferedBeforeConnect.length > 0
        ? Buffer.concat([header, ...bufferedBeforeConnect])
        : header;
    };

    const connectToTarget = (targetIndex: number) => {
      if (isFinalized) {
        return;
      }

      if (targetIndex >= tcpTargets.length) {
        console.error(chalk.red(`[TCP] ✗ All targets failed for ${clientAddr}`));
        abortConnection();
        return;
      }

      activeTarget = tcpTargets[targetIndex];
      targetStr = `${activeTarget.host}:${activeTarget.tcp}`;
      console.log(chalk.cyan(`[TCP] Establishing connection: ${proxyIP}:${proxyPort} => ${targetStr} (${targetIndex + 1}/${tcpTargets.length})`));

      const currentSocket = net.createConnection({
        host: activeTarget.host,
        port: activeTarget.tcp!,
      });
      destSocket = currentSocket;
      console.log(chalk.gray(`[TCP] Created destination socket for ${targetStr}`));
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
        if (targetIndex + 1 < tcpTargets.length) {
          console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
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
        console.log(chalk.green(`[TCP] ✓ Connected to target ${targetStr}`));
        console.log(chalk.gray(`[TCP] Destination socket local endpoint ${currentSocket.localAddress}:${currentSocket.localPort}`));
        armTargetToClientForwarding(currentSocket);

        try {
          await preparePreface(activeTarget);
          if (prefacePayloadBytes > 0) {
            console.log(chalk.dim(`[TCP] Forwarding initial data (${prefacePayloadBytes} bytes buffered)`));
          }
          flushClientToTarget();
          console.log(chalk.gray(`[TCP] Client -> target pump armed for ${clientAddr}`));
          console.log(chalk.green(`[TCP] ✓ Piping established for ${clientAddr}`));
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
          if (targetIndex + 1 < tcpTargets.length) {
            console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
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
        console.log(chalk.gray(`[TCP] Destination socket ended ${targetStr}`));
        if (!clientSocket.destroyed && !clientSocket.writableEnded) {
          clientSocket.end();
        }
      });

      currentSocket.on('close', () => {
        pendingConnectTimers.delete(connectTimer);
        clearTimeout(connectTimer);

        if (!settled && !destConnected && !isFinalized) {
          settled = true;
          if (targetIndex + 1 < tcpTargets.length) {
            console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
            connectToTarget(targetIndex + 1);
          } else {
            abortConnection();
          }
          return;
        }

        targetClosed = true;
        if (!isFinalized) {
          console.log(chalk.dim(`[TCP] Destination socket closed ${targetStr}`));
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
        console.log(chalk.dim(`[TCP] Incoming connection from ${clientAddr} => ${tcpTargets.map((target) => `${target.host}:${target.tcp}`).join(' -> ')}`));
        console.log(chalk.gray(`[TCP] Initial client data ${getBufferPreview(chunk)}`));

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
                console.log(chalk.gray(`[TCP] Initial payload after PROXY strip ${getBufferPreview(initialPayload)}`));
              } else {
                console.log(chalk.gray('[TCP] Initial payload after PROXY strip is empty'));
              }
              console.log(chalk.cyan('[TCP] Parsed proxy chain:'), {
                layers: chain.headers.length,
                original: `${proxyIP}:${proxyPort}`,
              });
            }
          } catch {
            // Treat as raw application payload.
          }
        }

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
      console.log(chalk.gray(`[TCP] Client socket ended ${clientAddr}`));
      if (destSocket && !destSocket.destroyed && !destSocket.writableEnded) {
        destSocket.end();
      }
    });

    clientSocket.on('close', () => {
      clearTimeout(initialDataTimer);
      clientClosed = true;
      console.log(chalk.gray(`[TCP] Client socket closed ${clientAddr}`));

      if (!destConnected && !isFinalized) {
        abortConnection();
        return;
      }

      finalizeConnection();
    });
  });

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
