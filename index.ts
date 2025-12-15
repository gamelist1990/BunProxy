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
import { sendDiscordWebhookEmbed, createPlayerJoinEmbed, createPlayerLeaveEmbed, createConnectionEmbed, createDisconnectionEmbed } from './services/discordEmbed.js';
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
const playerMapper = new TimestampPlayerMapper();
const connectionBuffer = new ConnectionBuffer();


function writeDefaultConfig() {
  const defaultConfig = {
    endpoint: 6000,
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
    let webhookSentForConn = false;
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    const connectionTime = Date.now();
    
    const originalIP = clientSocket.remoteAddress || '0.0.0.0';
    const originalPort = clientSocket.remotePort || 0;
    const targetStr = `${rule.target.host}:${rule.target.tcp}`;
    
    // Initial connection notice (kept brief)
    console.log(`[TCP] ${clientAddr} => ${targetStr}`);
    clientSocket.pause();
    let firstChunk: Buffer | null = null;
    let firstChunkHandled = false;
    let destConnected = false;
    
    const destSocket = net.connect(rule.target.tcp!, rule.target.host, async () => {
      destConnected = true;
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

        // Log a simplified mapping
        console.log(`[TCP] ${proxyIP}:${proxyPort} => ${targetStr}`);

        if (rule.haproxy) {
          const destIP = rule.target.host;
          const destPort = rule.target.tcp || 0;
          const header = generateProxyProtocolV2Header(proxyIP, proxyPort, destIP, destPort, false /* stream */);
          destSocket.write(header, () => {
            if (firstChunk) {
              destSocket.write(firstChunk);
            }
            clientSocket.resume();
            clientSocket.pipe(destSocket);
            destSocket.pipe(clientSocket);
            
            // Send webhook notification
            if (rule.webhook && !webhookSentForConn && rule.webhook.trim() !== '') {
              webhookSentForConn = true;
              if (useRestApi) {
                // REST API mode: add to buffer, Management API will handle webhook notification
                connectionBuffer.addPending(proxyIP, proxyPort, 'TCP', targetStr, () => {
                  // Management API handles webhook notification
                });
              } else {
                // Non-REST API mode: send immediately
                void sendDiscordWebhookEmbed(
                  rule.webhook,
                  createConnectionEmbed(proxyIP, proxyPort, 'TCP', targetStr)
                );
              }
            }
          });
        } else {
          // No proxy header addition; if we captured a first chunk, forward it first.
          if (firstChunk) destSocket.write(firstChunk);
          clientSocket.resume();
          clientSocket.pipe(destSocket);
          destSocket.pipe(clientSocket);
          
          // Send webhook notification
          if (rule.webhook && !webhookSentForConn && rule.webhook.trim() !== '') {
            webhookSentForConn = true;
            if (useRestApi) {
              // REST API mode: add to buffer, Management API will handle webhook notification
              connectionBuffer.addPending(proxyIP, proxyPort, 'TCP', targetStr, () => {
                // Management API handles webhook notification
              });
            } else {
              // Non-REST API mode: send immediately
              void sendDiscordWebhookEmbed(
                rule.webhook,
                createConnectionEmbed(proxyIP, proxyPort, 'TCP', targetStr)
              );
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
        playerName: undefined,
        headerSent: false,
        notified: false,
        logged: false,
      };
      sessions.set(key, session);

      const CLEANUP_MS = 60_000; // 60s
      session.timer = setTimeout(() => {
        // Notify on leave if webhook configured
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
            // If using REST API, do not send generic disconnection embeds for unknown players
            if (!useRestApi) {
              void sendDiscordWebhookEmbed(
                rule.webhook,
                createDisconnectionEmbed(
                  session!.clientAddress,
                  session!.clientPort,
                  'UDP',
                  `${rule.target.host}:${rule.target.udp}`
                )
              );
            }
          }
        }
        destSocket.close();
        sessions.delete(key);
      }, CLEANUP_MS);
    } else {
      if (session.timer) clearTimeout(session.timer as any);
      session.timer = setTimeout(() => {
        // Notify on leave if webhook configured
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
            // If using REST API, do not send generic disconnection embeds for unknown players
            if (!useRestApi) {
              void sendDiscordWebhookEmbed(
                rule.webhook,
                createDisconnectionEmbed(
                  session!.clientAddress,
                  session!.clientPort,
                  'UDP',
                  `${rule.target.host}:${rule.target.udp}`
                )
              );
            }
          }
        }
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

      // If webhook configured, handle notifications
      if (rule.webhook && !session!.notified && rule.webhook.trim() !== '') {
        session!.notified = true;
        const targetKey = `${rule.target.host}:${rule.target.udp}`;
        
        if (useRestApi) {
          // REST API mode: add to buffer, Management API will handle webhook notification
          connectionBuffer.addPending(originalIP, originalPort, 'UDP', targetKey, () => {
            // Management API handles webhook notification
          });
        } else {
          // Non-REST API mode: send immediately
          void sendDiscordWebhookEmbed(
            rule.webhook,
            createConnectionEmbed(originalIP, originalPort, 'UDP', targetKey)
          );
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
    const cfg = loadConfig() as any;
    const endpointPort = cfg.endpoint || 6000;
    const useRestApi = cfg.useRestApi ?? false;
    const savePlayerIP = cfg.savePlayerIP ?? true;
    
    // Initialize PlayerIPMapper
    const playerIPFilePath = path.join(process.cwd(), 'playerIP.json');
    const playerIPMapper = new PlayerIPMapper(playerIPFilePath, savePlayerIP);
    
    // Start management API (optional)
    if (useRestApi) {
      const webhooks = cfg.listeners
        .map((rule: any) => rule.webhook)
        .filter((hook: any) => hook && hook.trim() !== '');
      startManagementAPI(endpointPort, playerMapper, connectionBuffer, playerIPMapper, useRestApi, webhooks);
    }
    
    // Start periodic cleanup
    setInterval(() => {
      playerMapper.cleanup();
    }, 60_000); // Every 60 seconds
    
    for (const rule of cfg.listeners) {
      if (rule.tcp && rule.target.tcp) startTcpProxy(rule, useRestApi);
      if (rule.udp && rule.target.udp) startUdpProxy(rule, useRestApi);
    }
    
    console.log(`[Main] REST API Mode: ${useRestApi ? 'ENABLED' : 'DISABLED'}`);
  } catch (err) {
    console.error('Failed to start proxy', (err as Error).message);
    process.exit(1);
  }
}

main();
