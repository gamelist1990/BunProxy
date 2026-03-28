import fs from 'fs';
import path from 'path';
import net from 'net';
import dgram from 'dgram';
import { generateProxyProtocolV2Header } from './services/proxyProtocolBuilder.js';
import { buildUdpForwardPayload } from './services/udpProxyForwarding.js';
import { parseProxyV2Chain, getOriginalClientFromHeaders } from './services/proxyProtocolParser.js';
import { isRakNetSessionStartPacket } from './services/raknetPacket.js';
import { TimestampPlayerMapper } from './services/timestampPlayerMapper.js';
import { ConnectionBuffer } from './services/connectionBuffer.js';
import { PlayerIPMapper } from './services/playerIPMapper.js';
import { startManagementAPI } from './services/managementAPI.js';
import { sendDiscordWebhookEmbed, createPlayerLeaveEmbed, createConnectionEmbed, createDisconnectionEmbed, createGroupedConnectionEmbed, createGroupedDisconnectionEmbed } from './services/discordEmbed.js';
import YAML from 'yaml';
import dns from 'dns';
import chalk from 'chalk';
import Table from 'cli-table3';
import boxen from 'boxen';



type ListenerRule = {
  bind: string;
  tcp?: number;
  udp?: number;
  haproxy?: boolean;
  webhook?: string;
  target: {
    host: string;
    tcp?: number;
    udp?: number;
  };
  targets?: Array<{
    host: string;
    tcp?: number;
    udp?: number;
  }>;
};

type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

const CONFIG_FILE = path.join(process.cwd(), 'config.yml');
const playerMapper = new TimestampPlayerMapper();
const connectionBuffer = new ConnectionBuffer();

// Connection statistics
const connectionStats = {
  tcp: { total: 0, active: 0 },
  udp: { total: 0, active: 0 }
};

// Grouping structures: groupKey (webhook::protocol::target) -> map of ip -> set of ports
const groupedClients = new Map<string, Map<string, Set<number>>>();
const groupTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Disconnection grouping
const groupedDisconnects = new Map<string, Map<string, Set<number>>>();
const disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

const GROUP_WINDOW_MS = 3000; // 3 seconds window to aggregate ports/ips

function makeGroupKey(webhook: string, protocol: string, targetKey: string) {
  return `${webhook}::${protocol}::${targetKey}`;
}

function flushGroup(groupKey: string) {
  const parts = groupKey.split('::');
  const webhook = parts[0];
  const protocol = parts[1] as 'TCP' | 'UDP';
  const target = parts.slice(2).join('::');

  const map = groupedClients.get(groupKey);
  if (!map) return;

  const groups: Array<{ ip: string; ports: number[] }> = [];
  for (const [ip, portsSet] of map.entries()) {
    groups.push({ ip, ports: Array.from(portsSet).sort((a, b) => a - b) });
  }

  // Send one grouped embed
  void sendDiscordWebhookEmbed(webhook, createGroupedConnectionEmbed(target, protocol, groups));

  groupedClients.delete(groupKey);
  const t = groupTimers.get(groupKey);
  if (t) clearTimeout(t);
  groupTimers.delete(groupKey);
}

function flushDisconnectGroup(groupKey: string) {
  const parts = groupKey.split('::');
  const webhook = parts[0];
  const protocol = parts[1] as 'TCP' | 'UDP';
  const target = parts.slice(2).join('::');

  const map = groupedDisconnects.get(groupKey);
  if (!map) return;

  const groups: Array<{ ip: string; ports: number[] }> = [];
  for (const [ip, portsSet] of map.entries()) {
    groups.push({ ip, ports: Array.from(portsSet).sort((a, b) => a - b) });
  }

  // Send one grouped disconnection embed
  void sendDiscordWebhookEmbed(webhook, createGroupedDisconnectionEmbed(target, protocol, groups));

  groupedDisconnects.delete(groupKey);
  const t = disconnectTimers.get(groupKey);
  if (t) clearTimeout(t);
  disconnectTimers.delete(groupKey);
}

function addToConnectGroup(webhook: string, targetKey: string, ip: string, port: number, protocol: 'TCP' | 'UDP') {
  const groupKey = makeGroupKey(webhook, protocol, targetKey);
  let map = groupedClients.get(groupKey);
  if (!map) {
    map = new Map<string, Set<number>>();
    groupedClients.set(groupKey, map);
  }
  if (!map.has(ip)) map.set(ip, new Set<number>());
  map.get(ip)!.add(port);

  if (!groupTimers.has(groupKey)) {
    groupTimers.set(groupKey, setTimeout(() => flushGroup(groupKey), GROUP_WINDOW_MS));
  }
}

function addToDisconnectGroup(webhook: string, targetKey: string, ip: string, port: number, protocol: 'TCP' | 'UDP') {
  const groupKey = makeGroupKey(webhook, protocol, targetKey);
  let map = groupedDisconnects.get(groupKey);
  if (!map) {
    map = new Map<string, Set<number>>();
    groupedDisconnects.set(groupKey, map);
  }
  if (!map.has(ip)) map.set(ip, new Set<number>());
  map.get(ip)!.add(port);

  if (!disconnectTimers.has(groupKey)) {
    disconnectTimers.set(groupKey, setTimeout(() => flushDisconnectGroup(groupKey), GROUP_WINDOW_MS));
  }
}


function writeDefaultConfig() {
  const defaultConfig = {
    endpoint: 6000,
    useRestApi: false,
    savePlayerIP: true,
    listeners: [ 
      {
        bind: '0.0.0.0',
        tcp: 8000,
        udp: 8001,
        haproxy: false,
        webhook: '',
        target: { host: '127.0.0.1', tcp: 9000, udp: 9001 }
      }
    ]
  };
  fs.writeFileSync(CONFIG_FILE, YAML.stringify(defaultConfig), { encoding: 'utf-8' });
  console.log('Created default config.yml');
}

function normalizePort(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    throw new Error(`${fieldName} must be an integer port in range 1-65535`);
  }

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${fieldName} must be an integer port in range 1-65535`);
  }

  return parsed;
}

function stripHostBrackets(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeIPAddress(ip: string): string {
  const normalized = stripHostBrackets(ip);
  if (normalized.startsWith('::ffff:')) {
    const parts = normalized.split(':');
    const last = parts[parts.length - 1];
    if (net.isIP(last) === 4) {
      return last;
    }
  }
  return normalized;
}

function formatHostPort(host: string, port?: number): string {
  const normalizedHost = stripHostBrackets(host);
  const renderedHost = net.isIP(normalizedHost) === 6 ? `[${normalizedHost}]` : normalizedHost;
  return port === undefined ? renderedHost : `${renderedHost}:${port}`;
}

function formatResolvedTarget(host: string, port: number, resolvedAddress?: string): string {
  if (!resolvedAddress) {
    return formatHostPort(host, port);
  }

  const normalizedHost = normalizeIPAddress(host);
  const normalizedResolved = normalizeIPAddress(resolvedAddress);
  if (normalizedHost === normalizedResolved) {
    return formatHostPort(normalizedResolved, port);
  }

  return `${formatHostPort(normalizedHost, port)} [${normalizedResolved}]`;
}

async function resolveTargetAddresses(host: string): Promise<ResolvedAddress[]> {
  const normalizedHost = normalizeIPAddress(host);
  const literalFamily = net.isIP(normalizedHost);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: normalizedHost, family: literalFamily }];
  }

  const lookedUp = await dns.promises.lookup(normalizedHost, {
    all: true,
    verbatim: true,
  });

  const seen = new Set<string>();
  const resolved: ResolvedAddress[] = [];

  for (const entry of lookedUp) {
    const normalizedAddress = normalizeIPAddress(entry.address);
    const family = net.isIP(normalizedAddress);
    if ((family === 4 || family === 6) && !seen.has(`${family}:${normalizedAddress}`)) {
      seen.add(`${family}:${normalizedAddress}`);
      resolved.push({ address: normalizedAddress, family });
    }
  }

  return resolved;
}

function normalizeTarget(target: any, fieldName: string) {
  if (!target || typeof target !== 'object') {
    throw new Error(`${fieldName} must be an object`);
  }

  if (typeof target.host !== 'string' || target.host.trim() === '') {
    throw new Error(`${fieldName}.host must be a non-empty string`);
  }

  return {
    ...target,
    host: stripHostBrackets(target.host),
    tcp: normalizePort(target.tcp, `${fieldName}.tcp`),
    udp: normalizePort(target.udp, `${fieldName}.udp`),
  };
}

function getTargetsForProtocol(rule: ListenerRule, protocol: 'tcp' | 'udp') {
  const baseTargets = Array.isArray(rule.targets) && rule.targets.length > 0
    ? rule.targets
    : rule.target
      ? [rule.target]
      : [];

  return baseTargets.filter((target) => target[protocol] !== undefined);
}

function loadConfig(): { endpoint?: number; listeners: ListenerRule[] } {
  if (!fs.existsSync(CONFIG_FILE)) {
    writeDefaultConfig();
  }
  const text = fs.readFileSync(CONFIG_FILE, { encoding: 'utf-8' });
  const cfg = YAML.parse(text) as any;
  if (!cfg.listeners || !Array.isArray(cfg.listeners)) {
    throw new Error('config.yml must include a listeners array');
  }

  cfg.endpoint = normalizePort(cfg.endpoint, 'endpoint') ?? 6000;

  cfg.listeners = cfg.listeners.map((rule: any, index: number) => {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`listeners[${index}] must be an object`);
    }

    const normalizedTargets = Array.isArray(rule.targets)
      ? rule.targets.map((target: any, targetIndex: number) =>
          normalizeTarget(target, `listeners[${index}].targets[${targetIndex}]`))
      : rule.target
        ? [normalizeTarget(rule.target, `listeners[${index}].target`)]
        : [];

    if (normalizedTargets.length === 0) {
      throw new Error(`listeners[${index}] must define target or targets`);
    }

    return {
      ...rule,
      bind: typeof rule.bind === 'string' && rule.bind.trim() !== '' ? rule.bind : '0.0.0.0',
      tcp: normalizePort(rule.tcp, `listeners[${index}].tcp`),
      udp: normalizePort(rule.udp, `listeners[${index}].udp`),
      target: normalizedTargets[0],
      targets: normalizedTargets,
    } as ListenerRule;
  });

  return cfg as { endpoint?: number; listeners: ListenerRule[] };
}

// TCP proxy
function startTcpProxy(rule: ListenerRule, useRestApi: boolean) {
  const tcpTargets = getTargetsForProtocol(rule, 'tcp');
  if (rule.tcp === undefined || tcpTargets.length === 0) {
    return;
  }
  const CONNECT_TIMEOUT_MS = 10_000;
  const INITIAL_PROXY_METADATA_WAIT_MS = 250;
  const bindAddr = rule.bind || '0.0.0.0';
  const server = net.createServer((clientSocket: net.Socket) => {
    connectionStats.tcp.total++;
    connectionStats.tcp.active++;
    
    let webhookSentForConn = false;
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    const connectionTime = Date.now();

    const originalIP = clientSocket.remoteAddress || '0.0.0.0';
    const originalPort = clientSocket.remotePort || 0;
    let activeTarget = tcpTargets[0];
    let targetStr = formatHostPort(activeTarget.host, activeTarget.tcp);
    
    let clientToServerBytes = 0;
    let serverToClientBytes = 0;
    let isClosed = false;
    let firstChunk: Buffer | null = null;
    let proxyIP = originalIP;
    let proxyPort = originalPort;
    let destConnected = false;
    let destSocket: net.Socket | null = null;
    let initialDataHandled = false;
    let pipingEstablished = false;
    let forwardingStarted = false;
    let flushingPendingClientData = false;
    let loggedBufferedForward = false;
    let pendingClientChunks: Buffer[] = [];
    let outboundStartTimer: ReturnType<typeof setTimeout> | null = null;
    let startForwardingRef: (() => void) | null = null;

    const clearOutboundStartTimer = () => {
      if (outboundStartTimer) {
        clearTimeout(outboundStartTimer);
        outboundStartTimer = null;
      }
    };

    // クリーンアップ関数
    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      connectionStats.tcp.active--;
      clearOutboundStartTimer();
      
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

    console.log(chalk.dim(`[TCP] Incoming connection from ${clientAddr} => ${tcpTargets.map((target) => formatHostPort(target.host, target.tcp)).join(' -> ')}`));

    const setupPiping = () => {
      if (pipingEstablished || !destSocket) {
        return;
      }

      pipingEstablished = true;
      clientSocket.off('data', handleBufferedClientData);

      clientSocket.on('data', (chunk) => {
        clientToServerBytes += chunk.length;
      });
      
      destSocket.on('data', (chunk) => {
        serverToClientBytes += chunk.length;
      });
      
      clientSocket.pipe(destSocket);
      destSocket.pipe(clientSocket);
      
      console.log(chalk.green(`[TCP] ✓ Piping established for ${clientAddr}`));
    };

    const processInitialData = (buf: Buffer) => {
      firstChunk = buf;
      
      // Proxy Protocolヘッダーのパース
      if (buf.length > 16) {
        try {
          const chain = parseProxyV2Chain(buf);
          if (chain.headers.length > 0) {
            const orig = getOriginalClientFromHeaders(chain.headers);
            if (orig) {
              proxyIP = orig.ip || proxyIP;
              proxyPort = orig.port || proxyPort;
            }
            firstChunk = chain.payload.length > 0 ? chain.payload : null;
            if (pendingClientChunks.length > 0) {
              if (firstChunk && firstChunk.length > 0) {
                pendingClientChunks[0] = firstChunk;
              } else {
                pendingClientChunks.shift();
              }
            }
            console.log(chalk.cyan('[TCP] Parsed proxy chain:'), {
              layers: chain.headers.length,
              original: `${proxyIP}:${proxyPort}`,
              payloadLength: chain.payload.length,
            });
          }
        } catch (err) {
          // Proxy headerではない通常のデータ
        }
      }
    };

    const flushPendingClientData = () => {
      if (flushingPendingClientData || !destSocket || isClosed) {
        return;
      }

      flushingPendingClientData = true;

      const writeNext = () => {
        if (isClosed || !destSocket) {
          flushingPendingClientData = false;
          return;
        }

        const chunk = pendingClientChunks.shift();
        if (!chunk) {
          flushingPendingClientData = false;
          setupPiping();
          return;
        }

        if (chunk.length === 0) {
          writeNext();
          return;
        }

        if (!loggedBufferedForward) {
          console.log(chalk.dim(`[TCP] Forwarding buffered client data (${chunk.length} bytes)`));
          loggedBufferedForward = true;
        }

        clientToServerBytes += chunk.length;
        destSocket.write(chunk, (err) => {
          if (err) {
            console.error(chalk.red('[TCP] Failed to write buffered client data:'), err.message);
            cleanup();
            return;
          }

          writeNext();
        });
      };

      writeNext();
    };

    const handleBufferedClientData = (buf: Buffer) => {
      if (pipingEstablished || isClosed) {
        return;
      }

      pendingClientChunks.push(buf);

      if (!initialDataHandled) {
        initialDataHandled = true;
        clearOutboundStartTimer();
        processInitialData(buf);
      }

      if (destConnected && startForwardingRef && !forwardingStarted) {
        startForwardingRef();
      }
    };

    // Bun では接続直後に届く最初のデータを取りこぼすことがあるため、
    // 他のログや初期化より先に listener を貼る。
    clientSocket.on('data', handleBufferedClientData);

    const connectToTargets = async (targetIndex: number) => {
      if (isClosed) return;
      if (targetIndex >= tcpTargets.length) {
        console.error(chalk.red(`[TCP] ✗ All targets failed for ${clientAddr}`));
        cleanup();
        return;
      }

      activeTarget = tcpTargets[targetIndex];
      targetStr = formatHostPort(activeTarget.host, activeTarget.tcp);

      let resolvedAddresses: ResolvedAddress[];
      try {
        resolvedAddresses = await resolveTargetAddresses(activeTarget.host);
      } catch (err) {
        console.error(
          chalk.red(`[TCP] ✗ Failed to resolve ${activeTarget.host}:`),
          err instanceof Error ? err.message : String(err)
        );
        if (targetIndex + 1 < tcpTargets.length) {
          console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
          void connectToTargets(targetIndex + 1);
        } else {
          cleanup();
        }
        return;
      }

      if (resolvedAddresses.length === 0) {
        console.error(chalk.red(`[TCP] ✗ No IP addresses resolved for ${activeTarget.host}`));
        if (targetIndex + 1 < tcpTargets.length) {
          console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
          void connectToTargets(targetIndex + 1);
        } else {
          cleanup();
        }
        return;
      }

      const connectToResolvedAddress = (addressIndex: number) => {
        if (isClosed) return;
        if (addressIndex >= resolvedAddresses.length) {
          if (targetIndex + 1 < tcpTargets.length) {
            console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
            void connectToTargets(targetIndex + 1);
          } else {
            cleanup();
          }
          return;
        }

        const resolvedTarget = resolvedAddresses[addressIndex];
        const attemptTargetStr = formatResolvedTarget(
          activeTarget.host,
          activeTarget.tcp!,
          resolvedTarget.address
        );
        console.log(
          chalk.cyan(
            `[TCP] Establishing connection: ${proxyIP}:${proxyPort} => ${attemptTargetStr} (${targetIndex + 1}/${tcpTargets.length})`
          )
        );

        const currentSocket = net.createConnection({
          host: resolvedTarget.address,
          port: activeTarget.tcp!,
          family: resolvedTarget.family,
        });
        destSocket = currentSocket;
        currentSocket.setKeepAlive(true, 30_000);
        clientSocket.setKeepAlive(true, 30_000);

        let settled = false;
        const moveToNextTarget = (reason: string, err?: Error) => {
          if (settled || isClosed || destConnected) return;
          settled = true;
          clearTimeout(connectTimer);
          console.error(chalk.red(`[TCP] ✗ ${reason} ${attemptTargetStr}${err ? `: ${err.message}` : ''}`));
          if (err?.message.includes('ECONNREFUSED')) {
            console.error(chalk.red(`[TCP]   → Connection refused. Is the target server running on ${attemptTargetStr}?`));
          } else if (err?.message.includes('ETIMEDOUT')) {
            console.error(chalk.red(`[TCP]   → Connection timed out. Check network connectivity.`));
          } else if (err?.message.includes('EHOSTUNREACH') || err?.message.includes('ENETUNREACH')) {
            console.error(chalk.red(`[TCP]   → Host unreachable. Check firewall and routing.`));
          }
          currentSocket.destroy();
          if (addressIndex + 1 < resolvedAddresses.length) {
            console.log(chalk.yellow(`[TCP] ↻ Trying alternate address for ${formatHostPort(activeTarget.host, activeTarget.tcp)}`));
            connectToResolvedAddress(addressIndex + 1);
          } else if (targetIndex + 1 < tcpTargets.length) {
            console.log(chalk.yellow(`[TCP] ↻ Trying next target for ${clientAddr}`));
            void connectToTargets(targetIndex + 1);
          } else {
            cleanup();
          }
        };

        const connectTimer = setTimeout(() => {
          moveToNextTarget('Destination connect timeout');
        }, CONNECT_TIMEOUT_MS);

        const startForwarding = () => {
          if (isClosed || !destSocket || pipingEstablished || forwardingStarted) {
            return;
          }

          forwardingStarted = true;
          clearOutboundStartTimer();

          try {
            if (rule.haproxy) {
              const destPort = activeTarget.tcp || 0;
              const destIP = resolvedTarget.address;
              const header = generateProxyProtocolV2Header(proxyIP, proxyPort, destIP, destPort, false);
              console.log(chalk.blue(`[TCP] Sending PROXY header (${header.length} bytes) to ${formatHostPort(destIP, destPort)}`));

              destSocket.write(header, (err) => {
                if (err) {
                  console.error(chalk.red('[TCP] Failed to write PROXY header:'), err.message);
                  cleanup();
                  return;
                }

                flushPendingClientData();
              });
            } else {
              flushPendingClientData();
            }

            if (rule.webhook && !webhookSentForConn && rule.webhook.trim() !== '') {
              webhookSentForConn = true;
              if (useRestApi) {
                connectionBuffer.addPending(proxyIP, proxyPort, 'TCP', targetStr, () => {});
              } else {
                addToConnectGroup(rule.webhook, targetStr, proxyIP, proxyPort, 'TCP');
              }
            }
          } catch (err) {
            console.error(chalk.red('[TCP] Error during connection setup:'), err instanceof Error ? err.message : String(err));
            cleanup();
          }
        };
        startForwardingRef = startForwarding;

        currentSocket.on('connect', async () => {
          if (settled || isClosed) return;
          settled = true;
          clearTimeout(connectTimer);
          destConnected = true;
          currentSocket.setTimeout(0);
          console.log(chalk.green(`[TCP] ✓ Connected to target ${attemptTargetStr}`));

          if (initialDataHandled) {
            startForwarding();
            return;
          }

          clearOutboundStartTimer();
          outboundStartTimer = setTimeout(() => {
            if (isClosed || !destConnected) {
              return;
            }
            console.log(chalk.dim(`[TCP] No immediate client payload from ${clientAddr}; continuing with socket metadata`));
            startForwarding();
          }, INITIAL_PROXY_METADATA_WAIT_MS);
        });

        currentSocket.on('error', (err: Error) => {
          if (!settled && !destConnected) {
            moveToNextTarget('Destination socket error', err);
            return;
          }
          console.error(chalk.red(`[TCP] ✗ Destination socket error ${attemptTargetStr}:`), err.message);
          cleanup();
        });

        currentSocket.on('timeout', () => {
          if (!settled && !destConnected) {
            moveToNextTarget('Destination socket timeout');
            return;
          }
          console.error(chalk.red(`[TCP] ✗ Destination socket timeout ${attemptTargetStr}`));
          cleanup();
        });

        currentSocket.on('close', () => {
          clearTimeout(connectTimer);
          if (!settled && !destConnected) {
            moveToNextTarget('Destination socket closed before connect');
            return;
          }
          if (!isClosed) {
            console.log(chalk.dim(`[TCP] Destination socket closed ${attemptTargetStr}`));
            cleanup();
          }
        });
      };

      connectToResolvedAddress(0);
    };

    void connectToTargets(0);

    clientSocket.on('error', (err: Error) => {
      clearOutboundStartTimer();
      console.error(chalk.red('[TCP] Client socket error:'), err.message);
      cleanup();
    });

    clientSocket.on('timeout', () => {
      clearOutboundStartTimer();
      console.error(chalk.red('[TCP] Client socket timeout'));
      cleanup();
    });
    
    clientSocket.on('close', () => {
      clearOutboundStartTimer();
      if (!isClosed) {
        cleanup();
      }
    });
  });

  server.on('error', (err: Error) => {
    console.error(chalk.red('[TCP] Server error:'), err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') {
      console.error(chalk.red(`[TCP]   → Permission denied on ${formatHostPort(bindAddr, rule.tcp)}. Privileged ports (e.g. 80/443) may require elevated privileges.`));
    } else if (code === 'EADDRINUSE') {
      console.error(chalk.red(`[TCP]   → ${formatHostPort(bindAddr, rule.tcp)} is already in use by another process.`));
    }
  });

  server.listen(rule.tcp, bindAddr, () => {
    // Listening message will be shown in the startup table
  });
}

// UDP proxy
function startUdpProxy(rule: ListenerRule, useRestApi: boolean) {
  const udpTargets = getTargetsForProtocol(rule, 'udp');
  if (rule.udp === undefined || udpTargets.length === 0) return;
  const UDP_SESSION_IDLE_TIMEOUT_MS = 60_000;
  const UDP_INITIAL_RESPONSE_TIMEOUT_MS = 3_000;
  const bindAddr = rule.bind || '0.0.0.0';
  const socketType = net.isIP(bindAddr) === 6 ? 'udp6' : 'udp4';
  const server = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });

  type Session = {
    clientAddress: string;
    clientPort: number;
    destSocket?: dgram.Socket;
    destSocketType?: 'udp4' | 'udp6';
    playerName?: string;
    headerSent?: boolean;
    notified?: boolean;
    logged?: boolean;
    destHostResolved?: string;
    activeTargetIndex: number;
    hasReceivedResponse: boolean;
    responseTimer?: ReturnType<typeof setTimeout>;
    originalIP?: string;
    originalPort?: number;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sessions = new Map<string, Session>();

  function sessionKey(address: string, port: number) {
    return `${address}:${port}`;
  }

  function resetSessionRoutingState(session: Session) {
    session.headerSent = false;
    session.logged = false;
    session.notified = false;
    session.destHostResolved = undefined;
  }

  function refreshSessionTimer(key: string, session: Session) {
    if (session.timer) {
      clearTimeout(session.timer);
    }

    session.timer = setTimeout(() => {
      clearInitialResponseTimer(session);
      if (rule.webhook && rule.webhook.trim() !== '') {
        if (session.playerName) {
          void sendDiscordWebhookEmbed(
            rule.webhook,
            createPlayerLeaveEmbed(
              session.playerName,
              session.clientAddress,
              session.clientPort,
              'UDP'
            )
          );
        } else if (!useRestApi) {
          // Non-REST API mode: aggregate disconnect notifications
          const disconnectTarget = udpTargets[session.activeTargetIndex] ?? udpTargets[0];
          addToDisconnectGroup(rule.webhook, formatHostPort(disconnectTarget.host, disconnectTarget.udp), session.clientAddress, session.clientPort, 'UDP');
        }
      }

      if (session.destSocket) {
        session.destSocket.close();
        session.destSocket = undefined;
        session.destSocketType = undefined;
      }
      if (sessions.delete(key)) {
        connectionStats.udp.active--;
      }
      console.log(chalk.dim(`[UDP] Session timeout ${session.clientAddress}:${session.clientPort} (idle ${UDP_SESSION_IDLE_TIMEOUT_MS}ms)`));
    }, UDP_SESSION_IDLE_TIMEOUT_MS);
  }

  function clearInitialResponseTimer(session: Session) {
    if (session.responseTimer) {
      clearTimeout(session.responseTimer);
      session.responseTimer = undefined;
    }
  }

  function closeSession(key: string, session: Session) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    clearInitialResponseTimer(session);
    if (session.destSocket) {
      session.destSocket.close();
      session.destSocket = undefined;
      session.destSocketType = undefined;
    }
    if (sessions.delete(key)) {
      connectionStats.udp.active--;
    }
  }

  function createSessionDestSocket(key: string, session: Session, destSocketType: 'udp4' | 'udp6'): Promise<dgram.Socket> {
    return new Promise((resolve, reject) => {
      const destSocket = dgram.createSocket({ type: destSocketType });
      let resolved = false;

      destSocket.on('message', (response: Buffer) => {
        const activeSession = sessions.get(key);
        if (!activeSession) {
          return;
        }

        let clientResponse = response;
        try {
          const proxiedResponse = parseProxyV2Chain(response);
          if (proxiedResponse.headers.length > 0) {
            clientResponse = proxiedResponse.payload;
            console.log(chalk.dim(`[UDP] Stripped backend PROXY header (${response.length - clientResponse.length} bytes) for ${activeSession.clientAddress}:${activeSession.clientPort}`));
          }
        } catch {
          // Regular UDP payload
        }

        if (!activeSession.hasReceivedResponse) {
          const resolvedHost = activeSession.destHostResolved ?? 'unknown-target';
          const target = udpTargets[activeSession.activeTargetIndex] ?? udpTargets[0];
          console.log(chalk.green(`[UDP] ✓ Response ${formatHostPort(resolvedHost, target?.udp)} => ${activeSession.clientAddress}:${activeSession.clientPort} (${clientResponse.length} bytes)`));
        }

        activeSession.hasReceivedResponse = true;
        clearInitialResponseTimer(activeSession);
        refreshSessionTimer(key, activeSession);
        server.send(clientResponse, activeSession.clientPort, activeSession.clientAddress, (err: Error | null) => {
          if (err) {
            console.error('[UDP] Error sending back to client', err.message);
          }
        });
      });

      destSocket.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          reject(err);
          return;
        }

        console.error('[UDP] Dest socket error', err.message);
        const activeSession = sessions.get(key);
        if (activeSession?.destSocket === destSocket) {
          closeSession(key, activeSession);
        } else {
          destSocket.close();
        }
      });

      destSocket.bind(() => {
        if (resolved) {
          destSocket.close();
          return;
        }
        resolved = true;
        session.destSocket = destSocket;
        session.destSocketType = destSocketType;
        resolve(destSocket);
      });
    });
  }

  async function ensureSessionDestSocket(key: string, session: Session, family: 4 | 6): Promise<dgram.Socket> {
    const requiredSocketType = family === 6 ? 'udp6' : 'udp4';
    if (session.destSocket && session.destSocketType === requiredSocketType) {
      return session.destSocket;
    }

    if (session.destSocket) {
      session.destSocket.close();
      session.destSocket = undefined;
      session.destSocketType = undefined;
    }

    return createSessionDestSocket(key, session, requiredSocketType);
  }

  server.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const key = sessionKey(rinfo.address, rinfo.port);
    let session = sessions.get(key);

    if (!session) {
      connectionStats.udp.total++;
      connectionStats.udp.active++;

      session = {
        clientAddress: rinfo.address,
        clientPort: rinfo.port,
        playerName: undefined,
        headerSent: false,
        notified: false,
        logged: false,
        destHostResolved: undefined,
        activeTargetIndex: 0,
        hasReceivedResponse: false,
        responseTimer: undefined,
        originalIP: undefined,
        originalPort: undefined,
      };
      sessions.set(key, session);
    }

    // クライアントからの受信トラフィックでアイドルタイマー更新
    refreshSessionTimer(key, session);

    let originalIP = rinfo.address;
    let originalPort = rinfo.port;
    let actualPayload = msg;
    const activeTarget = udpTargets[session.activeTargetIndex] ?? udpTargets[0];
    try {
      const chain = parseProxyV2Chain(msg);
      if (chain.headers.length > 0) {
        const last = chain.headers[chain.headers.length - 1];
        originalIP = last.sourceAddress || originalIP;
        originalPort = last.sourcePort || originalPort;
        actualPayload = chain.payload;
        console.log(`[UDP] ${originalIP}:${originalPort} => ${formatHostPort(activeTarget.host, activeTarget.udp)} (payload=${actualPayload.length})`);
      }
    } catch (err) {
      console.log('[UDP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : err);
    }

    session.originalIP = originalIP;
    session.originalPort = originalPort;

    if (rule.haproxy && isRakNetSessionStartPacket(actualPayload)) {
      session.headerSent = false;
    }

    const trySendUdp = async (targetIndex: number) => {
      const target = udpTargets[targetIndex];
      if (!target) {
        return;
      }

      session!.activeTargetIndex = targetIndex;

      let resolvedAddresses: ResolvedAddress[];
      try {
        resolvedAddresses = await resolveTargetAddresses(target.host);
      } catch (err) {
        console.error(
          chalk.red(`[UDP] ✗ Failed to resolve ${target.host}:`),
          err instanceof Error ? err.message : String(err)
        );
        if (targetIndex + 1 < udpTargets.length) {
          console.log(chalk.yellow(`[UDP] ↻ Trying next target for ${originalIP}:${originalPort}`));
          resetSessionRoutingState(session!);
          await trySendUdp(targetIndex + 1);
        }
        return;
      }

      if (resolvedAddresses.length === 0) {
        console.error(chalk.red(`[UDP] ✗ No IP addresses resolved for ${target.host}`));
        if (targetIndex + 1 < udpTargets.length) {
          console.log(chalk.yellow(`[UDP] ↻ Trying next target for ${originalIP}:${originalPort}`));
          resetSessionRoutingState(session!);
          await trySendUdp(targetIndex + 1);
        }
        return;
      }

      const sendToResolvedAddress = async (addressIndex: number) => {
        const resolvedTarget = resolvedAddresses[addressIndex];
        const attemptTargetStr = formatResolvedTarget(target.host, target.udp!, resolvedTarget.address);

        let payload = actualPayload;
        try {
          const destSocket = await ensureSessionDestSocket(key, session!, resolvedTarget.family);
          session!.destHostResolved = resolvedTarget.address;

          if (rule.haproxy && !session!.headerSent) {
            payload = buildUdpForwardPayload(
              actualPayload,
              originalIP,
              originalPort,
              resolvedTarget.address,
              target.udp!
            );
            session!.headerSent = true;
          }

          destSocket.send(payload, target.udp!, resolvedTarget.address, async (err: Error | null) => {
            if (err) {
              console.error(chalk.red(`[UDP] ✗ Send error to ${attemptTargetStr}:`), err.message);
              resetSessionRoutingState(session!);
              if (addressIndex + 1 < resolvedAddresses.length) {
                console.log(chalk.yellow(`[UDP] ↻ Trying alternate address for ${formatHostPort(target.host, target.udp)}`));
                await sendToResolvedAddress(addressIndex + 1);
              } else if (targetIndex + 1 < udpTargets.length) {
                console.log(chalk.yellow(`[UDP] ↻ Trying next target for ${originalIP}:${originalPort}`));
                await trySendUdp(targetIndex + 1);
              }
              return;
            }

            if (!session!.logged) {
              console.log(chalk.green(`[UDP] ✓ Forwarding ${originalIP}:${originalPort} => ${attemptTargetStr} (${payload.length} bytes)`));
              session!.logged = true;
            }

            if (rule.webhook && !session!.notified && rule.webhook.trim() !== '') {
              session!.notified = true;
              const targetKey = formatHostPort(target.host, target.udp);

              if (useRestApi) {
                connectionBuffer.addPending(originalIP, originalPort, 'UDP', targetKey, () => {
                });
              } else {
                addToConnectGroup(rule.webhook, targetKey, originalIP, originalPort, 'UDP');
              }
            }

            const hasAlternateAddress = addressIndex + 1 < resolvedAddresses.length;
            const hasNextTarget = targetIndex + 1 < udpTargets.length;
            if (!session!.hasReceivedResponse && !session!.responseTimer && (hasAlternateAddress || hasNextTarget)) {
              session!.responseTimer = setTimeout(async () => {
                const activeSession = sessions.get(key);
                if (!activeSession || activeSession.hasReceivedResponse) {
                  return;
                }

                console.warn(chalk.yellow(
                  `[UDP] No response within ${UDP_INITIAL_RESPONSE_TIMEOUT_MS}ms from ${attemptTargetStr}; trying ${hasAlternateAddress ? 'alternate address' : 'next target'}`
                ));

                resetSessionRoutingState(activeSession);
                clearInitialResponseTimer(activeSession);

                if (hasAlternateAddress) {
                  await sendToResolvedAddress(addressIndex + 1);
                } else if (hasNextTarget) {
                  await trySendUdp(targetIndex + 1);
                }
              }, UDP_INITIAL_RESPONSE_TIMEOUT_MS);
            }
          });
        } catch (err) {
          console.error(chalk.red(`[UDP] ✗ Failed to prepare ${attemptTargetStr}:`), err instanceof Error ? err.message : String(err));
          resetSessionRoutingState(session!);
          if (addressIndex + 1 < resolvedAddresses.length) {
            console.log(chalk.yellow(`[UDP] ↻ Trying alternate address for ${formatHostPort(target.host, target.udp)}`));
            await sendToResolvedAddress(addressIndex + 1);
          } else if (targetIndex + 1 < udpTargets.length) {
            console.log(chalk.yellow(`[UDP] ↻ Trying next target for ${originalIP}:${originalPort}`));
            await trySendUdp(targetIndex + 1);
          }
        }
      };

      await sendToResolvedAddress(0);
    };

    void trySendUdp(session.activeTargetIndex);
  });

  server.on('listening', () => {
    // Listening message will be shown in the startup table
  });

  server.on('error', (err: Error) => {
    console.error('[UDP] Server error', err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES') {
      console.error(chalk.red(`[UDP]   → Permission denied on ${formatHostPort(bindAddr, rule.udp)}. Privileged ports (e.g. 80/443) may require elevated privileges.`));
    } else if (code === 'EADDRINUSE') {
      console.error(chalk.red(`[UDP]   → ${formatHostPort(bindAddr, rule.udp)} is already in use by another process.`));
    }
  });

  server.bind(rule.udp, bindAddr);
}

async function main() {
  try {
    console.clear();
    
    // Header
    console.log(boxen(chalk.bold.cyan('BunProxy Server'), {
      padding: 1,
      margin: 1,
      borderStyle: 'double',
      borderColor: 'cyan'
    }));

    const cfg = loadConfig() as any;
    const endpointPort = cfg.endpoint || 6000;
    const useRestApi = cfg.useRestApi ?? false;
    const savePlayerIP = cfg.savePlayerIP ?? true;

    const playerIPFilePath = path.join(process.cwd(), 'playerIP.json');
    const playerIPMapper = new PlayerIPMapper(playerIPFilePath, savePlayerIP);

    // Configuration table
    const configTable = new Table({
      head: [chalk.bold.white('Configuration'), chalk.bold.white('Value')],
      colWidths: [25, 30],
      style: { head: [], border: ['cyan'] }
    });

    configTable.push(
      ['REST API Mode', useRestApi ? chalk.green('✓ ENABLED') : chalk.yellow('✗ DISABLED')],
      ['Endpoint Port', chalk.cyan(endpointPort.toString())],
      ['Save Player IP', savePlayerIP ? chalk.green('✓ YES') : chalk.yellow('✗ NO')],
      ['Total Listeners', chalk.cyan(cfg.listeners.length.toString())]
    );

    console.log(configTable.toString());
    console.log('');


    // Start services
    if (useRestApi) {
      const webhooks = cfg.listeners
        .map((rule: any) => rule.webhook)
        .filter((hook: any) => hook && hook.trim() !== '');
      startManagementAPI(endpointPort, playerMapper, connectionBuffer, playerIPMapper, useRestApi, webhooks);
      console.log(chalk.green(`✓ Management API started on port ${endpointPort}`));
    }

    setInterval(() => {
      playerMapper.cleanup();
    }, 60_000);

    // Start proxies
    const listenerTable = new Table({
      head: [
        chalk.bold.white('Protocol'),
        chalk.bold.white('Listening'),
        chalk.bold.white('Forwarding To'),
        chalk.bold.white('HAProxy')
      ],
      colWidths: [10, 22, 28, 10],
      style: { head: [], border: ['green'] }
    });

    for (const rule of cfg.listeners) {
      const tcpTargets = getTargetsForProtocol(rule, 'tcp');
      const udpTargets = getTargetsForProtocol(rule, 'udp');

      if (rule.tcp !== undefined && tcpTargets.length > 0) {
        startTcpProxy(rule, useRestApi);
        listenerTable.push([
          chalk.blue('TCP'),
          chalk.cyan(formatHostPort(rule.bind, rule.tcp)),
          chalk.yellow(tcpTargets.map((target) => formatHostPort(target.host, target.tcp)).join(' -> ')),
          rule.haproxy ? chalk.green('✓') : chalk.gray('✗')
        ]);
      }
      if (rule.udp !== undefined && udpTargets.length > 0) {
        startUdpProxy(rule, useRestApi);
        listenerTable.push([
          chalk.magenta('UDP'),
          chalk.cyan(formatHostPort(rule.bind, rule.udp)),
          chalk.yellow(udpTargets.map((target) => formatHostPort(target.host, target.udp)).join(' -> ')),
          rule.haproxy ? chalk.green('✓') : chalk.gray('✗')
        ]);
      }
    }

    console.log(chalk.bold.green('\n✓ All listeners started:\n'));
    console.log(listenerTable.toString());
    
    console.log('');
    console.log(boxen(chalk.bold.green('✓ Server is running'), {
      padding: 0,
      margin: { top: 0, bottom: 1, left: 0, right: 0 },
      borderStyle: 'round',
      borderColor: 'green',
      textAlignment: 'center'
    }));

  } catch (err) {
    console.error(chalk.bold.red('✗ Failed to start proxy:'), chalk.red((err as Error).message));
    process.exit(1);
  }
}

main();
