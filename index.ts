import fs from 'fs';
import path from 'path';
import net from 'net';
import dgram from 'dgram';
import { generateProxyProtocolV2Header } from './services/proxyProtocolBuilder.js';
import { parseProxyV2, parseProxyV2Chain, getOriginalClientFromHeaders } from './services/proxyProtocolParser.js';
import YAML from 'yaml';


type ListenerRule = {
  bind: string;
  tcp?: number;
  udp?: number;
  haproxy?: boolean; // enable proxy protocol v2
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
    const clientAddr = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
    console.log(`[TCP] Connection from ${clientAddr} -> ${rule.target.host}:${rule.target.tcp}`);
    // pause client while we establish dest and possibly write PROXY header
    clientSocket.pause();
    let firstChunk: Buffer | null = null;
    let firstChunkHandled = false;
    let destConnected = false;
    const destSocket = net.connect(rule.target.tcp!, rule.target.host, async () => {
      destConnected = true;
      try {
        // Determine original client IP: if the incoming client has PROXY v2 headers, prefer the last header's source.
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

        if (rule.haproxy) {
          const destIP = rule.target.host;
          const destPort = rule.target.tcp || 0;
          const header = generateProxyProtocolV2Header(originalIP, originalPort, destIP, destPort, false /* stream */);
          console.log(`[TCP] Attaching PROXY v2 header for original ${originalIP}:${originalPort} -> ${destIP}:${destPort}, headerLength=${header.length}`);
          // Write our header, then forward the initial chunk (which may contain upstream PROXY header(s)).
          destSocket.write(header, () => {
            if (firstChunk) {
              destSocket.write(firstChunk);
            }
            clientSocket.resume();
            clientSocket.pipe(destSocket);
            destSocket.pipe(clientSocket);
          });
        } else {
          // No proxy header addition; if we captured a first chunk, forward it first.
          if (firstChunk) destSocket.write(firstChunk);
          clientSocket.resume();
          clientSocket.pipe(destSocket);
          destSocket.pipe(clientSocket);
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
      // If destination already connected and not handled, trigger handling.
      if (destConnected && !firstChunkHandled) {
        firstChunkHandled = true;
        // nothing else here: destSocket.connect callback handles the firstChunk sending
      }
    });
  });

  server.on('error', (err: Error) => {
    console.error('[TCP] Server error', err);
  });

  server.listen(rule.tcp, bindAddr, () => {
    console.log(`[TCP] Listening on ${bindAddr}:${rule.tcp} -> ${rule.target.host}:${rule.target.tcp}`);
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
      // Create a new socket for talking to destination
      const destSocket = dgram.createSocket({ type: socketType as 'udp4' | 'udp6' });
      destSocket.on('message', (response: Buffer, destInfo: dgram.RemoteInfo) => {
        // forward back to original client
        server.send(response, rinfo.port, rinfo.address, (err: Error | null) => {
          if (err) console.error('[UDP] Error sending back to client', err.message);
        });
      });
      destSocket.on('error', (err: Error) => {
        console.error('[UDP] Dest socket error', err.message);
      });
      // Bind to an ephemeral port
      destSocket.bind(() => {
        // nothing here
      });

      session = {
        clientAddress: rinfo.address,
        clientPort: rinfo.port,
        destSocket,
        headerSent: false,
      };
      sessions.set(key, session);

      // Setup cleanup timer
      const CLEANUP_MS = 60_000; // 60s inactivity
      session.timer = setTimeout(() => {
        destSocket.close();
        sessions.delete(key);
      }, CLEANUP_MS);
    } else {
      // reset timer
      if (session.timer) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session?.destSocket.close();
        sessions.delete(key);
      }, 60_000);
    }

    // Detect incoming proxy-protocol chain and decide what origin to report
    let originalIP = rinfo.address;
    let originalPort = rinfo.port;
    let actualPayload = msg; // Start with full message
    try {
      const chain = parseProxyV2Chain(msg);
      if (chain.headers.length > 0) {
        const last = chain.headers[chain.headers.length - 1];
        originalIP = last.sourceAddress || originalIP;
        originalPort = last.sourcePort || originalPort;
        actualPayload = chain.payload; // Extract actual data after PROXY headers
        console.log('[UDP] Received PROXY chain', {
          rinfo: `${rinfo.address}:${rinfo.port}`,
          chainLayers: chain.headers.length,
          original: `${originalIP}:${originalPort}`,
          payloadLength: actualPayload.length,
        });
      }
    } catch (err) {
      // ignore parse errors
      console.log('[UDP] failed to parse incoming PROXY header chain', err instanceof Error ? err.message : err);
    }

    // Prepare payload — attach PROXY v2 header for the first packet when haproxy enabled
    // Always use actualPayload (cleaned from upstream PROXY headers) for all packets
    let payload = actualPayload;
    if (rule.haproxy && !session.headerSent) {
      try {
        const header = generateProxyProtocolV2Header(originalIP, originalPort, rule.target.host, rule.target.udp!, true /* dgram */);
        console.log(`[UDP] Attaching PROXY v2 header for original ${originalIP}:${originalPort} -> ${rule.target.host}:${rule.target.udp}, headerLength=${header.length}, payloadSize=${actualPayload.length}, totalSize=${header.length + actualPayload.length}`);
        payload = Buffer.concat([header, actualPayload]); // First packet: PROXY header + payload
        session.headerSent = true;
      } catch (err) {
        console.error('[UDP] Failed to generate PROXY header', err instanceof Error ? err.message : String(err));
      }
    }
    // Subsequent packets: send actualPayload only (without PROXY header)

    // send message to destination
    session.destSocket.send(payload, rule.target.udp!, rule.target.host, (err: Error | null) => {
      if (err) console.error('[UDP] send error', err.message);
    });
  });

  server.on('listening', () => {
    const addr = server.address() as any;
    console.log(`[UDP] Listening on ${bindAddr}:${rule.udp} -> ${rule.target.host}:${rule.target.udp}`);
  });

  server.on('error', (err: Error) => {
    console.error('[UDP] Server error', err.message);
  });

  server.bind(rule.udp, bindAddr);
}

// Entrypoint
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
