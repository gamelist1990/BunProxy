import dgram from 'dgram';
import dns from 'dns';
import net from 'net';
import chalk from 'chalk';
import {
  createPlayerLeaveEmbed,
  sendDiscordWebhookEmbed,
} from './discordEmbed.js';
import {
  inspectBedrockUnconnectedPong,
  rewriteBedrockUnconnectedPongPorts,
} from './bedrockPong.js';
import { getBufferPreview } from './logPreview.js';
import { getTargetsForProtocol } from './proxyConfig.js';
import { generateProxyProtocolV2Header } from './proxyProtocolBuilder.js';
import { parseProxyV2Chain } from './proxyProtocolParser.js';
import {
  describeRakNetPacket,
  getRakNetPacketKind,
  getRakNetSessionPacketKind,
  getRakNetSessionStage,
  isRakNetSessionStartPacket,
  type RakNetSessionStage,
} from './raknetPacket.js';
import type { ListenerRule } from './proxyTypes.js';
import type { ProxyRuntime } from './proxyRuntime.js';

const UDP_SESSION_IDLE_TIMEOUT_MS = 60_000;

type UdpSession = {
  clientAddress: string;
  clientPort: number;
  destSocket: dgram.Socket;
  playerName?: string;
  headerSent?: boolean;
  notified?: boolean;
  logged?: boolean;
  activeTargetIndex: number;
  requestLogCount: number;
  responseLogCount: number;
  stage: RakNetSessionStage;
  timer?: ReturnType<typeof setTimeout>;
};

function sessionKey(address: string, port: number) {
  return `${address}:${port}`;
}

export function startUdpProxy(rule: ListenerRule, runtime: ProxyRuntime) {
  const udpTargets = getTargetsForProtocol(rule, 'udp');
  if (rule.udp === undefined || udpTargets.length === 0) {
    return;
  }

  const bindAddr = rule.bind || '0.0.0.0';
  const socketType = net.isIP(bindAddr) === 6 ? 'udp6' : 'udp4';
  const server = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });
  const sessions = new Map<string, UdpSession>();
  const debugLog = (...args: unknown[]) => {
    if (runtime.debug) {
      console.log(...args);
    }
  };

  const updateSessionStage = (
    session: UdpSession,
    nextStage: RakNetSessionStage,
    reason: string,
  ) => {
    if (nextStage === 'other' || session.stage === nextStage) {
      return;
    }

    debugLog(chalk.cyan(`[UDP] Session stage ${session.stage} -> ${nextStage} for ${session.clientAddress}:${session.clientPort} (${reason})`));
    session.stage = nextStage;
  };

  const destroySession = (key: string, session: UdpSession, reason: string) => {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }

    sessions.delete(key);
    session.destSocket.close();
    runtime.connectionStats.udp.active--;
    debugLog(chalk.dim(`[UDP] Session closed ${session.clientAddress}:${session.clientPort} (${reason}, stage=${session.stage})`));
  };

  const refreshSessionTimer = (key: string, session: UdpSession) => {
    if (session.timer) {
      clearTimeout(session.timer);
    }

    session.timer = setTimeout(() => {
      if (rule.webhook && rule.webhook.trim() !== '') {
        if (session.playerName) {
          void sendDiscordWebhookEmbed(
            rule.webhook,
            createPlayerLeaveEmbed(session.playerName, session.clientAddress, session.clientPort, 'UDP'),
          );
        } else if (!runtime.useRestApi) {
          const disconnectTarget = udpTargets[session.activeTargetIndex] ?? udpTargets[0];
          runtime.groupedNotifier.addDisconnectGroup(
            rule.webhook,
            `${disconnectTarget.host}:${disconnectTarget.udp}`,
            session.clientAddress,
            session.clientPort,
            'UDP',
          );
        }
      }

      destroySession(key, session, `idle ${UDP_SESSION_IDLE_TIMEOUT_MS}ms`);
    }, UDP_SESSION_IDLE_TIMEOUT_MS);
  };

  const createSession = (key: string, clientAddress: string, clientPort: number) => {
    runtime.connectionStats.udp.total++;
    runtime.connectionStats.udp.active++;

    const destSocket = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });
    const session: UdpSession = {
      clientAddress,
      clientPort,
      destSocket,
      playerName: undefined,
      headerSent: false,
      notified: false,
      logged: false,
      activeTargetIndex: 0,
      requestLogCount: 0,
      responseLogCount: 0,
      stage: 'other',
    };

    destSocket.on('message', (response, destInfo) => {
      const activeSession = sessions.get(key);
      if (!activeSession) {
        return;
      }

      refreshSessionTimer(key, activeSession);
      let responsePayload: Buffer = Buffer.from(response);

      try {
        const chain = parseProxyV2Chain(responsePayload);
        if (chain.headers.length > 0) {
          responsePayload = Buffer.from(chain.payload);
          debugLog(chalk.gray(`[UDP] Stripped backend PROXY header for ${activeSession.clientAddress}:${activeSession.clientPort}`));
        }
      } catch {
        // Treat as raw RakNet payload.
      }

      if (rule.rewriteBedrockPongPorts && rule.udp !== undefined) {
        const rewritten = rewriteBedrockUnconnectedPongPorts(responsePayload, rule.udp);
        if (rewritten.rewritten) {
          responsePayload = rewritten.payload;
          debugLog(chalk.blue(
            `[UDP] Rewrote Bedrock pong advertised ports ` +
            `${rewritten.originalPorts?.ipv4 ?? 'n/a'}/${rewritten.originalPorts?.ipv6 ?? 'n/a'} -> ${rule.udp}/${rule.udp}`
          ));
        }
      }

      const responseKind = getRakNetPacketKind(responsePayload);
      const responseStage = getRakNetSessionStage(responseKind);
      updateSessionStage(activeSession, responseStage, `server ${describeRakNetPacket(responsePayload)}`);

      const inspectedPong = inspectBedrockUnconnectedPong(responsePayload);
      if (inspectedPong) {
        debugLog(chalk.blue(
          `[UDP] Bedrock pong fields for ${activeSession.clientAddress}:${activeSession.clientPort}: ` +
          `ports=${inspectedPong.advertisedPortV4 ?? 'n/a'}/${inspectedPong.advertisedPortV6 ?? 'n/a'} ` +
          `motd="${inspectedPong.motd}"`
        ));
      }

      if (activeSession.responseLogCount < 3) {
        debugLog(chalk.gray(`[UDP] Target -> client ${describeRakNetPacket(responsePayload)} from ${destInfo.address}:${destInfo.port} ${getBufferPreview(responsePayload)}`));
      } else if (activeSession.responseLogCount === 3) {
        debugLog(chalk.gray(`[UDP] Additional target->client datagram logs suppressed for ${activeSession.clientAddress}:${activeSession.clientPort}`));
      }
      activeSession.responseLogCount++;

      server.send(responsePayload, clientPort, clientAddress, (err) => {
        if (err) {
          console.error('[UDP] Error sending back to client', err.message);
          return;
        }

        debugLog(chalk.gray(`[UDP] Sent ${responsePayload.length}B back to client ${clientAddress}:${clientPort}`));
      });
    });

    destSocket.on('error', (err) => {
      console.error('[UDP] Dest socket error', err.message);
      const activeSession = sessions.get(key);
      if (!activeSession) {
        return;
      }

      if (activeSession.timer) {
        clearTimeout(activeSession.timer);
      }
      destroySession(key, activeSession, `destination socket error: ${err.message}`);
    });

    destSocket.bind(() => {
      // Bind to an ephemeral local port.
    });

    sessions.set(key, session);
    return session;
  };

  server.on('message', (msg, rinfo) => {
    const key = sessionKey(rinfo.address, rinfo.port);
    let originalIP = rinfo.address;
    let originalPort = rinfo.port;
    let actualPayload: Buffer = Buffer.from(msg);
    let session = sessions.get(key);
    const currentTarget = udpTargets[session?.activeTargetIndex ?? 0] ?? udpTargets[0];

    try {
      const chain = parseProxyV2Chain(msg);
      if (chain.headers.length > 0) {
        const last = chain.headers[chain.headers.length - 1];
        originalIP = last.sourceAddress || originalIP;
        originalPort = last.sourcePort || originalPort;
        actualPayload = Buffer.from(chain.payload);
        debugLog(`[UDP] ${originalIP}:${originalPort} => ${currentTarget.host}:${currentTarget.udp} (payload=${actualPayload.length})`);
      }
    } catch (err) {
      debugLog('[UDP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : String(err));
    }

    const isSessionStartPacket = isRakNetSessionStartPacket(actualPayload);
    if (
      session &&
      isSessionStartPacket &&
      (session.stage === 'connected' || session.stage === 'disconnecting')
    ) {
      debugLog(chalk.yellow(
        `[UDP] Reinitializing stale session for ${originalIP}:${originalPort} ` +
        `after ${describeRakNetPacket(actualPayload)} (previous stage=${session.stage})`
      ));
      destroySession(key, session, `restart on ${describeRakNetPacket(actualPayload)}`);
      session = undefined;
    }

    const rakNetPacket = getRakNetPacketKind(actualPayload);
    const rakNetPacketKind = getRakNetSessionPacketKind(actualPayload);

    if (!session) {
      session = createSession(key, rinfo.address, rinfo.port);
    }
    if (!session) {
      return;
    }

    refreshSessionTimer(key, session);
    updateSessionStage(session, getRakNetSessionStage(rakNetPacket), `client ${describeRakNetPacket(actualPayload)}`);

    if (session.requestLogCount < 3) {
      debugLog(chalk.gray(`[UDP] Client -> target ${describeRakNetPacket(actualPayload)} ${getBufferPreview(actualPayload)}`));
    } else if (session.requestLogCount === 3) {
      debugLog(chalk.gray(`[UDP] Additional client->target datagram logs suppressed for ${originalIP}:${originalPort}`));
    }
    session.requestLogCount++;

    if (rakNetPacket === 'disconnect_notification') {
      destroySession(key, session, 'client disconnect notification');
      return;
    }

    const forceProxyHeader = rule.haproxy && rakNetPacketKind === 'offline_ping';
    if (forceProxyHeader) {
      debugLog(chalk.gray(`[UDP] RakNet offline ping detected for ${originalIP}:${originalPort}; PROXY header will be resent`));
    }

    const trySendUdp = async (targetIndex: number): Promise<void> => {
      const target = udpTargets[targetIndex];
      if (!target) {
        return;
      }

      session!.activeTargetIndex = targetIndex;

      let resolved = target.host;
      try {
        if (net.isIP(resolved) === 0) {
          const addr = await dns.promises.lookup(target.host);
          resolved = addr.address;
        }
      } catch {
        resolved = target.host;
      }

      let payload = actualPayload;
      if (rule.haproxy && (forceProxyHeader || !session!.headerSent)) {
        try {
          const header = generateProxyProtocolV2Header(
            originalIP,
            originalPort,
            resolved,
            target.udp!,
            true,
          );
          payload = Buffer.concat([header, actualPayload]);
          if (rakNetPacketKind !== 'offline_ping') {
            session!.headerSent = true;
          }
          debugLog(chalk.gray(`[UDP] PROXY header preview ${getBufferPreview(header)}`));
        } catch (err) {
          console.error('[UDP] Failed to generate PROXY header', err instanceof Error ? err.message : String(err));
        }
      }

      session!.destSocket.send(payload, target.udp!, resolved, async (err) => {
        if (err) {
          console.error(chalk.red(`[UDP] ✗ Send error to ${target.host}:${target.udp}:`), err.message);
          if (targetIndex + 1 < udpTargets.length) {
            debugLog(chalk.yellow(`[UDP] ↻ Trying next target for ${originalIP}:${originalPort}`));
            session!.headerSent = false;
            session!.logged = false;
            session!.notified = false;
            await trySendUdp(targetIndex + 1);
          }
          return;
        }

        if (!session!.logged) {
          debugLog(chalk.green(`[UDP] ✓ Forwarding ${originalIP}:${originalPort} => ${target.host}:${target.udp} (${payload.length} bytes)`));
          session!.logged = true;
        }

        if (rule.webhook && !session!.notified && rule.webhook.trim() !== '') {
          session!.notified = true;
          const targetKey = `${target.host}:${target.udp}`;
          if (runtime.useRestApi) {
            runtime.connectionBuffer.addPending(originalIP, originalPort, 'UDP', targetKey, () => {});
          } else {
            runtime.groupedNotifier.addConnectGroup(rule.webhook, targetKey, originalIP, originalPort, 'UDP');
          }
        }
      });
    };

    void trySendUdp(session.activeTargetIndex);
  });

  server.on('error', (err: Error) => {
    console.error('[UDP] Server error', err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') {
      console.error(chalk.red(`[UDP]   → Permission denied on ${bindAddr}:${rule.udp}. Privileged ports (e.g. 80/443) may require elevated privileges.`));
    } else if (code === 'EADDRINUSE') {
      console.error(chalk.red(`[UDP]   → ${bindAddr}:${rule.udp} is already in use by another process.`));
    }
  });

  server.bind(rule.udp, bindAddr);
}
