import http from 'http';
import type { TimestampPlayerMapper } from './timestampPlayerMapper.js';
import type { ConnectionBuffer } from './connectionBuffer.js';
import type { PlayerIPMapper } from './playerIPMapper.js';
import { sendDiscordWebhookEmbed, createPlayerJoinEmbed, createConnectionEmbed, createPlayerLoginEmbed, createPlayerLogoutEmbed } from './discordEmbed.js';

/**
 * REST API server for player login/logout notifications
 * Listens for POST requests with timestamp and username
 */
export function startManagementAPI(
  port: number,
  playerMapper: TimestampPlayerMapper,
  connectionBuffer: ConnectionBuffer,
  playerIPMapper: PlayerIPMapper,
  useRestApi: boolean,
  webhooks?: string[]
): http.Server {
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // POST /api/login - Register player login
    if (req.method === 'POST' && req.url === '/api/login') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { timestamp, username } = data;

          if (typeof timestamp !== 'number' || !username || typeof username !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request: timestamp (number) and username (string) required' }));
            return;
          }

          playerMapper.registerLogin(timestamp, username);

          // If REST API is enabled, process pending connections
          if (useRestApi) {
            const { matched } = connectionBuffer.processPendingForPlayer(username, timestamp);
            
            console.log(`[Management API] Player login: ${username}`);
            
            // Process all matched pending connections
            // Group by IP and protocol to avoid duplicate notifications
            const grouped = new Map<string, { ip: string; ports: number[]; protocol: 'TCP' | 'UDP'; target: string }>();
            
            for (const pending of matched) {
              console.log(
                `[${pending.protocol}] ${pending.ip}:${pending.port} [${username}] => ${pending.target}`
              );
              
              // Save player IP mapping
              playerIPMapper.registerPlayerIP(username, pending.ip, pending.port, pending.protocol);
              
              const groupKey = `${pending.ip}:${pending.protocol}`;
              if (!grouped.has(groupKey)) {
                grouped.set(groupKey, {
                  ip: pending.ip,
                  ports: [],
                  protocol: pending.protocol,
                  target: pending.target,
                });
              }
              grouped.get(groupKey)!.ports.push(pending.port);
            }

            // Send Discord notification if webhooks provided (one per IP/protocol group)
            if (webhooks) {
              for (const group of grouped.values()) {
                for (const webhook of webhooks) {
                  if (webhook && webhook.trim() !== '') {
                    void sendDiscordWebhookEmbed(
                      webhook,
                      createPlayerJoinEmbed(username, group.ip, group.ports, group.protocol)
                    );
                  }
                }
              }
            }

              // If no pending connections matched, still send a login notification
              if (webhooks && matched.length === 0) {
                for (const webhook of webhooks) {
                  if (webhook && webhook.trim() !== '') {
                    void sendDiscordWebhookEmbed(
                      webhook,
                      createPlayerLoginEmbed(username, 'Management API')
                    );
                  }
                }
              }

          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Player ${username} login registered`,
            timestamp,
            timestampStr: new Date(timestamp).toISOString(),
          }));
        } catch (err) {
          console.error('[Management API] Error parsing login:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/logout - Register player logout
    if (req.method === 'POST' && req.url === '/api/logout') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { timestamp, username } = data;

          if (typeof timestamp !== 'number' || !username || typeof username !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request: timestamp (number) and username (string) required' }));
            return;
          }

          playerMapper.registerLogout(timestamp, username);
          console.log(`[Management API] Player logout: ${username}`);

          // Send Discord notification if webhooks provided
          if (webhooks && useRestApi) {
            // Get saved IP information
            const ipRecord = playerIPMapper.getPlayerIPs(username);
            
            if (ipRecord && ipRecord.ips.length > 0) {
              // Group IPs by protocol
              const grouped = new Map<string, { ip: string; ports: number[]; protocol: 'TCP' | 'UDP' }>();
              
              for (const ipInfo of ipRecord.ips) {
                const key = `${ipInfo.ip}:${ipInfo.protocol}`;
                if (!grouped.has(key)) {
                  grouped.set(key, {
                    ip: ipInfo.ip,
                    ports: [...ipInfo.ports],
                    protocol: ipInfo.protocol,
                  });
                }
              }
              
              // Send notification for each IP/protocol group
              for (const group of grouped.values()) {
                for (const webhook of webhooks) {
                  if (webhook && webhook.trim() !== '') {
                    void sendDiscordWebhookEmbed(
                      webhook,
                      createPlayerLogoutEmbed(username, group.ip, group.ports, group.protocol, 'Management API')
                    );
                  }
                }
              }
            } else {
              // No IP info available, send without IP
              for (const webhook of webhooks) {
                if (webhook && webhook.trim() !== '') {
                  void sendDiscordWebhookEmbed(
                    webhook,
                    createPlayerLogoutEmbed(username, undefined, undefined, undefined, 'Management API')
                  );
                }
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Player ${username} logout registered`,
            timestamp,
            timestampStr: new Date(timestamp).toISOString(),
          }));
        } catch (err) {
          console.error('[Management API] Error parsing logout:', err);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // GET /api/players - List all tracked players
    if (req.method === 'GET' && req.url === '/api/players') {
      const players = playerMapper.getAllPlayers();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ players, count: players.length }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[Management API] Listening on http://0.0.0.0:${port}`);
  });

  return server;
}
