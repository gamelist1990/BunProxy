import fs from 'fs';

export interface PlayerIPRecord {
  username: string;
  ips: Array<{
    ip: string;
    protocol: 'TCP' | 'UDP';
    lastSeen: number;
  }>;
}


export class PlayerIPMapper {
  private storage: Map<string, PlayerIPRecord> = new Map();
  private readonly filePath: string;
  private readonly enabled: boolean;

  constructor(filePath: string, enabled: boolean) {
    this.filePath = filePath;
    this.enabled = enabled;
    if (this.enabled) {
      this.load();
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const parsed: any[] = JSON.parse(data);
        const records: PlayerIPRecord[] = parsed.map((r: any) => {
          const username = r.username;
          const ipsArr = Array.isArray(r.ips) ? r.ips : [];
          let latest: any = null;
          for (const e of ipsArr) {
            if (!latest || (e.lastSeen && e.lastSeen > (latest.lastSeen || 0))) latest = e;
          }
          const normalizedIps = latest ? [{ ip: latest.ip, protocol: latest.protocol, lastSeen: latest.lastSeen || Date.now() }] : [];
          return { username, ips: normalizedIps };
        });
        for (const record of records) {
          this.storage.set(record.username, record);
        }
        console.log(`[PlayerIPMapper] Loaded ${records.length} player IP records`);
        this.save();
      }
    } catch (err) {
      console.error('[PlayerIPMapper] Failed to load file:', err instanceof Error ? err.message : String(err));
    }
  }


  private save(): void {
    if (!this.enabled) return;

    try {
      const records = Array.from(this.storage.values());
      fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (err) {
      console.error('[PlayerIPMapper] Failed to save file:', err instanceof Error ? err.message : String(err));
    }
  }


  registerPlayerIP(username: string, ip: string, port: number, protocol: 'TCP' | 'UDP'): void {
    if (!this.enabled) return;

    let record = this.storage.get(username);
    if (!record) {
      record = {
        username,
        ips: [],
      };
      this.storage.set(username, record);
    }

    const now = Date.now();

    if (record.ips.length === 0) {
      record.ips = [{ ip, protocol, lastSeen: now }];
    } else {
      const existing = record.ips[0];
      if (existing.ip !== ip || existing.protocol !== protocol) {
        existing.ip = ip;
        existing.protocol = protocol;
      }
      existing.lastSeen = now;
      record.ips = [existing];
    }

    this.save();
  }


  getPlayerIPs(username: string): PlayerIPRecord | undefined {
    return this.storage.get(username);
  }


  removePlayer(username: string): void {
    if (!this.enabled) return;

    this.storage.delete(username);
    this.save();
  }


  cleanup(olderThanDays: number = 30): void {
    if (!this.enabled) return;

    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let cleaned = 0;

    for (const [username, record] of this.storage.entries()) {
      record.ips = record.ips.filter(ip => ip.lastSeen > cutoff);

      if (record.ips.length === 0) {
        this.storage.delete(username);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[PlayerIPMapper] Cleaned up ${cleaned} old player records`);
      this.save();
    }
  }
}
