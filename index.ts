import fs from 'fs';
import path from 'path';
import net from 'net';
import dgram from 'dgram';
import { generateProxyProtocolV2Header } from './services/proxyProtocolBuilder.js';
import { parseProxyV2Chain, getOriginalClientFromHeaders } from './services/proxyProtocolParser.js';
import YAML from 'yaml';

async function sendDiscordWebhook(webhookUrl: string, content: string): Promise<void> {
  try {
    if (!webhookUrl || webhookUrl.trim() === '') return;
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    try { console.error('[Webhook] Failed to send webhook', err instanceof Error ? err.message : String(err)); } catch (_) {}
  }
}


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


function writeDefaultConfig() {
  const defaultConfig = {
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

function loadConfig(): { listeners: ListenerRule[] } {
  if (!fs.existsSync(CONFIG_FILE)) {
    writeDefaultConfig();
  }
  const text = fs.readFileSync(CONFIG_FILE, { encoding: 'utf-8' });
  const cfg = YAML.parse(text);
  if (!cfg.listeners || !Array.isArray(cfg.listeners)) {
    throw new Error('config.yml must include a listeners array');
  }
  return cfg as { listeners: ListenerRule[] };
}

// TCP proxy
function startTcpProxy(rule: ListenerRule) {
  if (!rule.tcp || !rule.target.tcp) {
    return;
  }
  const bindAddr = rule.bind || '0.0.0.0';
  const server = net.createServer((clientSocket: net.Socket) => {
    let webhookSentForConn = false;
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    // Initial connection notice (kept brief)
    console.log(`[TCP] ${clientAddr} => ${rule.target.host}:${rule.target.tcp}`);
    clientSocket.pause();
    let firstChunk: Buffer | null = null;
    let firstChunkHandled = false;
    let destConnected = false;
    const destSocket = net.connect(rule.target.tcp!, rule.target.host, async () => {
      destConnected = true;
      try {
        let originalIP = clientSocket.remoteAddress || '0.0.0.0';
        let originalPort = clientSocket.remotePort || 0;
        if (firstChunk) {
          try {
            const chain = parseProxyV2Chain(firstChunk);
            if (chain.headers.length > 0) {
              const orig = getOriginalClientFromHeaders(chain.headers);
              if (orig) {
                originalIP = orig.ip || originalIP;
                originalPort = orig.port || originalPort;
              }
              console.log('[TCP] parsed proxy chain on incoming connection', {
                remote: `${clientSocket.remoteAddress}:${clientSocket.remotePort}`,
                chainLayers: chain.headers.length,
                original: `${originalIP}:${originalPort}`
              });
            }
          } catch (err) {
            console.log('[TCP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : err);
          }
        }

        // Log a simplified mapping using the resolved original IP/port (after parsing if available)
        console.log(`[TCP] ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.tcp}`);

        if (rule.haproxy) {
          const destIP = rule.target.host;
          const destPort = rule.target.tcp || 0;
          const header = generateProxyProtocolV2Header(originalIP, originalPort, destIP, destPort, false /* stream */);
          destSocket.write(header, () => {
            if (firstChunk) {
              destSocket.write(firstChunk);
            }
            clientSocket.resume();
            clientSocket.pipe(destSocket);
            destSocket.pipe(clientSocket);
            if (rule.webhook && !webhookSentForConn) {
              webhookSentForConn = true;
              void sendDiscordWebhook(rule.webhook, `[TCP] ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.tcp}`);
            }
          });
        } else {
          // No proxy header addition; if we captured a first chunk, forward it first.
          if (firstChunk) destSocket.write(firstChunk);
          clientSocket.resume();
          clientSocket.pipe(destSocket);
          destSocket.pipe(clientSocket);
          if (rule.webhook && !webhookSentForConn) {
            webhookSentForConn = true;
            void sendDiscordWebhook(rule.webhook, `[TCP] ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.tcp}`);
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
      console.error('[TCP] Destination error', err.message);
      clientSocket.end();
    });
    clientSocket.on('error', (err: Error) => {
      console.error('[TCP] Client socket error', err.message);
      destSocket.end();
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
    console.log(`[TCP] Listening on ${bindAddr}:${rule.tcp} => ${rule.target.host}:${rule.target.tcp}`);
  });
}

// UDP proxy
function startUdpProxy(rule: ListenerRule) {
  if (!rule.udp || !rule.target.udp) return;
  const bindAddr = rule.bind || '0.0.0.0';
  const socketType = net.isIP(bindAddr) === 6 ? 'udp6' : 'udp4';
  const server = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });

  type Session = {
    clientAddress: string;
    clientPort: number;
    destSocket: dgram.Socket;
    headerSent?: boolean;
    notified?: boolean;
    logged?: boolean;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sessions = new Map<string, Session>();

  // Grouping structures: targetKey -> map of ip -> set of ports
  const groupedClients = new Map<string, Map<string, Set<number>>>();
  const groupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function sessionKey(address: string, port: number) {
    return `${address}:${port}`;
  }

  server.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
    const key = sessionKey(rinfo.address, rinfo.port);
    let session = sessions.get(key);
    if (!session) {
      // Create a new socket for talking to destination
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
        headerSent: false,
        notified: false,
        logged: false,
      };
      sessions.set(key, session);

      const CLEANUP_MS = 60_000; // 60s
      session.timer = setTimeout(() => {
        destSocket.close();
        sessions.delete(key);
      }, CLEANUP_MS);
    } else {
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session?.destSocket.close();
        sessions.delete(key);
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
        // Simplified UDP mapping log
        console.log(`[UDP] ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.udp} (payload=${actualPayload.length})`);
      }
    } catch (err) {
      console.log('[UDP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : err);
    }

    
    let payload = actualPayload;
    if (rule.haproxy && !session.headerSent) {
      try {
        const header = generateProxyProtocolV2Header(originalIP, originalPort, rule.target.host, rule.target.udp!, true /* dgram */);
        payload = Buffer.concat([header, actualPayload]); // First packet: PROXY header + payload
        session.headerSent = true;
      } catch (err) {
        console.error('[UDP] Failed to generate PROXY header', err instanceof Error ? err.message : String(err));
      }
    }

    session.destSocket.send(payload, rule.target.udp!, rule.target.host, (err: Error | null) => {
      if (err) {
        console.error('[UDP] send error', err.message);
        return;
      }

      // Log to console only once per session to avoid spam
      if (!session!.logged) {
        console.log(`[UDP] ${originalIP}:${originalPort} => ${rule.target.host}:${rule.target.udp}`);
        session!.logged = true;
      }

      // If webhook configured, aggregate notifications per target and dedupe by IP
      if (rule.webhook && !session!.notified) {
        session!.notified = true;
        const targetKey = `${rule.target.host}:${rule.target.udp}`;
        let ipMap = groupedClients.get(targetKey);
        if (!ipMap) {
          ipMap = new Map<string, Set<number>>();
          groupedClients.set(targetKey, ipMap);
        }
        const ports = ipMap.get(originalIP) || new Set<number>();
        ports.add(originalPort);
        ipMap.set(originalIP, ports);

        // Schedule a grouped notification shortly (debounce)
        if (!groupTimers.has(targetKey)) {
          const t = setTimeout(() => {
            const map = groupedClients.get(targetKey);
            if (!map) return;
            const parts: string[] = [];
            for (const [ip, portsSet] of map.entries()) {
              if (portsSet.size === 0) parts.push(ip);
              else if (portsSet.size === 1) parts.push(`${ip}:${Array.from(portsSet)[0]}`);
              else parts.push(`${ip}(${Array.from(portsSet).join(',')})`);
            }
            // Format aggregated notification as "clients => target"
            const body = `[UDP] ${parts.join(', ')} => ${targetKey}`;
            // Send aggregated webhook (do not duplicate this aggregated line to console)
            void sendDiscordWebhook(rule.webhook!, body);
            groupedClients.delete(targetKey);
            groupTimers.delete(targetKey);
          }, 500);
          groupTimers.set(targetKey, t);
        }
      }
    });
  });

  server.on('listening', () => {
    const addr = server.address() as any;
    console.log(`[UDP] Listening on ${bindAddr}:${rule.udp} => ${rule.target.host}:${rule.target.udp}`);
  });

  server.on('error', (err: Error) => {
    console.error('[UDP] Server error', err.message);
  });

  server.bind(rule.udp, bindAddr);
}

function main() {
  try {
    const cfg = loadConfig();
    for (const rule of cfg.listeners) {
      if (rule.tcp && rule.target.tcp) startTcpProxy(rule);
      if (rule.udp && rule.target.udp) startUdpProxy(rule);
    }
  } catch (err) {
    console.error('Failed to start proxy', (err as Error).message);
    process.exit(1);
  }
}

main();
