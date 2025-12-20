import fs from 'fs';
import path from 'path';
import net from 'net';
import dgram from 'dgram';
import { generateProxyProtocolV2Header } from './services/proxyProtocolBuilder.js';
import { parseProxyV2Chain, getOriginalClientFromHeaders } from './services/proxyProtocolParser.js';
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


// Check if target host:port is reachable
async function checkTargetReachability(host: string, port: number, protocol: 'TCP' | 'UDP', timeout = 3000): Promise<{ reachable: boolean; latency?: number; error?: string }> {
  const startTime = Date.now();
  
  if (protocol === 'TCP') {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port, timeout });
      
      socket.on('connect', () => {
        const latency = Date.now() - startTime;
        socket.destroy();
        resolve({ reachable: true, latency });
      });
      
      socket.on('error', (err) => {
        resolve({ reachable: false, error: err.message });
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve({ reachable: false, error: 'Connection timeout' });
      });
    });
  } else {
    // UDP check - send a probe packet and wait for response or timeout
    // Note: Many UDP services don't respond to empty packets, so this may show false negatives
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      const timeoutId = setTimeout(() => {
        socket.close();
        // UDP timeout is not necessarily a failure - UDP services may not respond to probes
        resolve({ reachable: false, error: 'No response (normal for UDP)' });
      }, timeout);
      
      socket.on('message', () => {
        clearTimeout(timeoutId);
        const latency = Date.now() - startTime;
        socket.close();
        resolve({ reachable: true, latency });
      });
      
      socket.on('error', (err) => {
        clearTimeout(timeoutId);
        socket.close();
        resolve({ reachable: false, error: err.message });
      });
      
      // Send empty probe packet
      socket.send(Buffer.alloc(0), port, host, (err) => {
        if (err) {
          clearTimeout(timeoutId);
          socket.close();
          resolve({ reachable: false, error: err.message });
        }
      });
    });
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

function loadConfig(): { endpoint?: number; listeners: ListenerRule[] } {
  if (!fs.existsSync(CONFIG_FILE)) {
    writeDefaultConfig();
  }
  const text = fs.readFileSync(CONFIG_FILE, { encoding: 'utf-8' });
  const cfg = YAML.parse(text);
  if (!cfg.listeners || !Array.isArray(cfg.listeners)) {
    throw new Error('config.yml must include a listeners array');
  }
  return cfg as { endpoint?: number; listeners: ListenerRule[] };
}

// TCP proxy
function startTcpProxy(rule: ListenerRule, useRestApi: boolean) {
  if (!rule.tcp || !rule.target.tcp) {
    return;
  }
  const bindAddr = rule.bind || '0.0.0.0';
  const server = net.createServer((clientSocket: net.Socket) => {
    connectionStats.tcp.total++;
    connectionStats.tcp.active++;
    
    let webhookSentForConn = false;
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    const connectionTime = Date.now();

    const originalIP = clientSocket.remoteAddress || '0.0.0.0';
    const originalPort = clientSocket.remotePort || 0;
    const targetStr = `${rule.target.host}:${rule.target.tcp}`;
    
    let clientToServerBytes = 0;
    let serverToClientBytes = 0;

    console.log(chalk.dim(`[TCP] ${clientAddr} => ${targetStr}`));
    clientSocket.pause();
    let firstChunk: Buffer | null = null;
    let firstChunkHandled = false;
    let destConnected = false;

    const destSocket = net.connect(rule.target.tcp!, rule.target.host, async () => {
      destConnected = true;
      console.log(chalk.green(`[TCP] ✓ Connected to target ${targetStr}`));
      try {
        let proxyIP = originalIP;
        let proxyPort = originalPort;
        if (firstChunk) {
          try {
            const chain = parseProxyV2Chain(firstChunk);
            if (chain.headers.length > 0) {
              const orig = getOriginalClientFromHeaders(chain.headers);
              if (orig) {
                proxyIP = orig.ip || proxyIP;
                proxyPort = orig.port || proxyPort;
              }
              console.log('[TCP] parsed proxy chain on incoming connection', {
                remote: `${clientSocket.remoteAddress}:${clientSocket.remotePort}`,
                chainLayers: chain.headers.length,
                original: `${proxyIP}:${proxyPort}`
              });
            }
          } catch (err) {
            console.log('[TCP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : err);
          }
        }

        console.log(`[TCP] ${proxyIP}:${proxyPort} => ${targetStr}`);

        if (rule.haproxy) {
          const destPort = rule.target.tcp || 0;
          let destIP = rule.target.host;
          try {
            if (net.isIP(destIP) === 0) {
              const addr = await dns.promises.lookup(destIP);
              destIP = addr.address;
            }
          } catch (err) {
            console.warn('[TCP] Failed to resolve destination host for PROXY header, using original host', err instanceof Error ? err.message : String(err));
          }
          const header = generateProxyProtocolV2Header(proxyIP, proxyPort, destIP, destPort, false /* stream */);
          console.log(chalk.blue(`[TCP] Sending PROXY header (${header.length} bytes) to ${destIP}:${destPort}`));
          destSocket.write(header, () => {
            if (firstChunk) {
              console.log(chalk.dim(`[TCP] Forwarding initial data (${firstChunk.length} bytes)`));
              destSocket.write(firstChunk);
            }
            clientSocket.resume();
            
            clientSocket.on('data', (chunk) => {
              clientToServerBytes += chunk.length;
            });
            
            destSocket.on('data', (chunk) => {
              serverToClientBytes += chunk.length;
            });
            
            clientSocket.pipe(destSocket);
            destSocket.pipe(clientSocket);

            if (rule.webhook && !webhookSentForConn && rule.webhook.trim() !== '') {
              webhookSentForConn = true;
              if (useRestApi) {
                connectionBuffer.addPending(proxyIP, proxyPort, 'TCP', targetStr, () => {
                });
              } else {
                addToConnectGroup(rule.webhook, targetStr, proxyIP, proxyPort, 'TCP');
              }
            }
          });
        } else {
          if (firstChunk) destSocket.write(firstChunk);
          clientSocket.resume();
          clientSocket.pipe(destSocket);
          destSocket.pipe(clientSocket);

          if (rule.webhook && !webhookSentForConn && rule.webhook.trim() !== '') {
            webhookSentForConn = true;
            if (useRestApi) {
              connectionBuffer.addPending(proxyIP, proxyPort, 'TCP', targetStr, () => {
              });
            } else {
              // Non-REST API mode: aggregate notifications to avoid spam
              addToConnectGroup(rule.webhook, targetStr, proxyIP, proxyPort, 'TCP');
            }
          }
        }
      } catch (err) {
        console.error('[TCP] Failed to send PROXY header', err instanceof Error ? err.message : String(err));
        clientSocket.resume();
        clientSocket.pipe(destSocket);
        destSocket.pipe(clientSocket);
      }
    });
    destSocket.on('error', (err: Error) => {
      console.error(chalk.red(`[TCP] ✗ Destination error ${targetStr}:`), err.message);
      if (!destConnected) {
        console.error(chalk.red(`[TCP] ✗ Failed to connect to target ${targetStr}`));
      }
      clientSocket.end();
    });
    clientSocket.on('error', (err: Error) => {
      console.error(chalk.red('[TCP] Client socket error'), err.message);
      destSocket.end();
    });
    
    clientSocket.on('close', () => {
      connectionStats.tcp.active--;
      if (destConnected) {
        console.log(chalk.yellow(`[TCP] Connection closed ${clientAddr} (sent: ${clientToServerBytes || 0}B, recv: ${serverToClientBytes || 0}B)`));
      }
    });

    clientSocket.once('data', (buf) => {
      firstChunk = buf;
      if (destConnected && !firstChunkHandled) {
        firstChunkHandled = true;
      }
    });
  });

  server.on('error', (err: Error) => {
    console.error('[TCP] Server error', err);
  });

  server.listen(rule.tcp, bindAddr, () => {
    // Listening message will be shown in the startup table
  });
}

// UDP proxy
function startUdpProxy(rule: ListenerRule, useRestApi: boolean) {
  if (!rule.udp || !rule.target.udp) return;
  const bindAddr = rule.bind || '0.0.0.0';
  const socketType = net.isIP(bindAddr) === 6 ? 'udp6' : 'udp4';
  const server = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });

  type Session = {
    clientAddress: string;
    clientPort: number;
    destSocket: dgram.Socket;
    playerName?: string;
    headerSent?: boolean;
    notified?: boolean;
    logged?: boolean;
    destHostResolved?: string;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sessions = new Map<string, Session>();



  function sessionKey(address: string, port: number) {
    return `${address}:${port}`;
  }

  server.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const key = sessionKey(rinfo.address, rinfo.port);
    let session = sessions.get(key);

    if (!session) {
      connectionStats.udp.total++;
      connectionStats.udp.active++;
      
      const destSocket = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });
      destSocket.on('message', (response: Buffer, destInfo: dgram.RemoteInfo) => {
        server.send(response, rinfo.port, rinfo.address, (err: Error | null) => {
          if (err) console.error('[UDP] Error sending back to client', err.message);
        });
      });
      destSocket.on('error', (err: Error) => {
        console.error('[UDP] Dest socket error', err.message);
      });
      destSocket.bind(() => {
        // None
      });

      session = {
        clientAddress: rinfo.address,
        clientPort: rinfo.port,
        destSocket,
        playerName: undefined,
        headerSent: false,
        notified: false,
        logged: false,
        destHostResolved: undefined,
      };
      sessions.set(key, session);

      // Resolve target host to numeric IP for PROXY header (supports hostnames and local IPs like Tailscale)
      (async () => {
        try {
          let resolved = rule.target.host;
          if (net.isIP(resolved) === 0) {
            const addr = await dns.promises.lookup(rule.target.host);
            resolved = addr.address;
          }
          session!.destHostResolved = resolved;
        } catch (err) {
          session!.destHostResolved = rule.target.host;
        }
      })();

      const CLEANUP_MS = 60_000; // 60s
      session.timer = setTimeout(() => {
        if (rule.webhook && rule.webhook.trim() !== '') {
          if (session?.playerName) {
            void sendDiscordWebhookEmbed(
              rule.webhook,
              createPlayerLeaveEmbed(
                session.playerName,
                session.clientAddress,
                session.clientPort,
                'UDP'
              )
            );
          } else {
            if (!useRestApi) {
              // Non-REST API mode: aggregate disconnect notifications
              addToDisconnectGroup(rule.webhook, `${rule.target.host}:${rule.target.udp}`, session!.clientAddress, session!.clientPort, 'UDP');
            }
          }
        }
        destSocket.close();
        sessions.delete(key);
        connectionStats.udp.active--;
      }, CLEANUP_MS);
    } else {
      if (session.timer) clearTimeout(session.timer as any);
      session.timer = setTimeout(() => {
        if (rule.webhook && rule.webhook.trim() !== '') {
          if (session?.playerName) {
            void sendDiscordWebhookEmbed(
              rule.webhook,
              createPlayerLeaveEmbed(
                session.playerName,
                session.clientAddress,
                session.clientPort,
                'UDP'
              )
            );
          } else {
            if (!useRestApi) {
              // Non-REST API mode: aggregate disconnect notifications
              addToDisconnectGroup(rule.webhook, `${rule.target.host}:${rule.target.udp}`, session!.clientAddress, session!.clientPort, 'UDP');
            }
          }
        }
        session?.destSocket.close();
        sessions.delete(key);
        connectionStats.udp.active--;
      }, 60_000);
    }

    let originalIP = rinfo.address;
    let originalPort = rinfo.port;
    let actualPayload = msg;
    try {
      const chain = parseProxyV2Chain(msg);
      if (chain.headers.length > 0) {
        const last = chain.headers[chain.headers.length - 1];
        originalIP = last.sourceAddress || originalIP;
        originalPort = last.sourcePort || originalPort;
        actualPayload = chain.payload;
        console.log(`[UDP] ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.udp} (payload=${actualPayload.length})`);
      }
    } catch (err) {
      console.log('[UDP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : err);
    }


    let payload = actualPayload;
    if (rule.haproxy && !session.headerSent) {
      try {
        const header = generateProxyProtocolV2Header(originalIP, originalPort, session.destHostResolved ?? rule.target.host, rule.target.udp!, true /* dgram */);
        payload = Buffer.concat([header, actualPayload]); // First packet: PROXY header + payload
        session.headerSent = true;
      } catch (err) {
        console.error('[UDP] Failed to generate PROXY header', err instanceof Error ? err.message : String(err));
      }
    }

    session.destSocket.send(payload, rule.target.udp!, rule.target.host, (err: Error | null) => {
      if (err) {
        console.error(chalk.red(`[UDP] ✗ Send error to ${rule.target.host}:${rule.target.udp}:`), err.message);
        return;
      }

      if (!session!.logged) {
        console.log(chalk.green(`[UDP] ✓ Forwarding ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.udp} (${payload.length} bytes)`));
        session!.logged = true;
      }

      if (rule.webhook && !session!.notified && rule.webhook.trim() !== '') {
        session!.notified = true;
        const targetKey = `${rule.target.host}:${rule.target.udp}`;

        if (useRestApi) {
          connectionBuffer.addPending(originalIP, originalPort, 'UDP', targetKey, () => {
          });
        } else {
          // Non-REST API mode: aggregate notifications to avoid spam
          addToConnectGroup(rule.webhook, targetKey, originalIP, originalPort, 'UDP');
        }
      }
    });
  });

  server.on('listening', () => {
    // Listening message will be shown in the startup table
  });

  server.on('error', (err: Error) => {
    console.error('[UDP] Server error', err.message);
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

    // Check target reachability
    console.log(chalk.bold.yellow('⏳ Checking target reachability...\n'));
    
    const reachabilityTable = new Table({
      head: [
        chalk.bold.white('Protocol'),
        chalk.bold.white('Bind'),
        chalk.bold.white('Target'),
        chalk.bold.white('Status'),
        chalk.bold.white('Latency')
      ],
      colWidths: [10, 22, 28, 15, 12],
      style: { head: [], border: ['cyan'] }
    });

    const checks: Promise<void>[] = [];
    const results: Array<{ rule: ListenerRule; protocol: 'TCP' | 'UDP'; result: Awaited<ReturnType<typeof checkTargetReachability>> }> = [];

    for (const rule of cfg.listeners) {
      if (rule.tcp && rule.target.tcp) {
        checks.push(
          checkTargetReachability(rule.target.host, rule.target.tcp, 'TCP').then(result => {
            results.push({ rule, protocol: 'TCP', result });
          })
        );
      }
      if (rule.udp && rule.target.udp) {
        checks.push(
          checkTargetReachability(rule.target.host, rule.target.udp, 'UDP').then(result => {
            results.push({ rule, protocol: 'UDP', result });
          })
        );
      }
    }

    await Promise.all(checks);

    // Display reachability results
    for (const { rule, protocol, result } of results) {
      const bindAddr = `${rule.bind}:${protocol === 'TCP' ? rule.tcp : rule.udp}`;
      const targetAddr = `${rule.target.host}:${protocol === 'TCP' ? rule.target.tcp : rule.target.udp}`;
      const status = result.reachable 
        ? chalk.green('✓ OK')
        : chalk.red('✗ FAILED');
      const latency = result.reachable && result.latency !== undefined
        ? chalk.green(`${result.latency}ms`)
        : chalk.red(result.error || 'N/A');
      
      reachabilityTable.push([
        protocol === 'TCP' ? chalk.blue('TCP') : chalk.magenta('UDP'),
        chalk.white(bindAddr),
        chalk.white(targetAddr),
        status,
        latency
      ]);
    }

    console.log(reachabilityTable.toString());
    
    // Check if there are any UDP warnings
    const hasUdpWarnings = results.some(r => r.protocol === 'UDP' && !r.result.reachable);
    if (hasUdpWarnings) {
      console.log(chalk.yellow('\n⚠ Note: UDP services often don\'t respond to probe packets. Failed UDP checks may still work for actual traffic.'));
    }
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
      if (rule.tcp && rule.target.tcp) {
        startTcpProxy(rule, useRestApi);
        listenerTable.push([
          chalk.blue('TCP'),
          chalk.cyan(`${rule.bind}:${rule.tcp}`),
          chalk.yellow(`${rule.target.host}:${rule.target.tcp}`),
          rule.haproxy ? chalk.green('✓') : chalk.gray('✗')
        ]);
      }
      if (rule.udp && rule.target.udp) {
        startUdpProxy(rule, useRestApi);
        listenerTable.push([
          chalk.magenta('UDP'),
          chalk.cyan(`${rule.bind}:${rule.udp}`),
          chalk.yellow(`${rule.target.host}:${rule.target.udp}`),
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
