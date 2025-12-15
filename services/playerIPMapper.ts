import fs from 'fs';
import path from 'path';

/**
 * Player IP mapping storage
 * Maps username to IP addresses and ports for logout notifications
 */
export interface PlayerIPRecord {
  username: string;
  ips: Array<{
    ip: string;
    ports: number[];
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

  /**
   * Load player IP mappings from file
   */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf-8');
        const records: PlayerIPRecord[] = JSON.parse(data);
        for (const record of records) {
          this.storage.set(record.username, record);
        }
        console.log(`[PlayerIPMapper] Loaded ${records.length} player IP records`);
      }
    } catch (err) {
      console.error('[PlayerIPMapper] Failed to load file:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Save player IP mappings to file
   */
  private save(): void {
    if (!this.enabled) return;
    
    try {
      const records = Array.from(this.storage.values());
      fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (err) {
      console.error('[PlayerIPMapper] Failed to save file:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Register player IP and port
   */
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

    // Find existing IP record
    let ipRecord = record.ips.find(r => r.ip === ip && r.protocol === protocol);
    if (!ipRecord) {
      ipRecord = {
        ip,
        ports: [],
        protocol,
        lastSeen: Date.now(),
      };
      record.ips.push(ipRecord);
    }

    // Add port if not already present
    if (!ipRecord.ports.includes(port)) {
      ipRecord.ports.push(port);
    }
    ipRecord.lastSeen = Date.now();

    this.save();
  }

  /**
   * Get player IPs
   */
  getPlayerIPs(username: string): PlayerIPRecord | undefined {
    return this.storage.get(username);
  }

  /**
   * Remove player record (optional, for cleanup)
   */
  removePlayer(username: string): void {
    if (!this.enabled) return;
    
    this.storage.delete(username);
    this.save();
  }

  /**
   * Clean up old records (older than specified days)
   */
  cleanup(olderThanDays: number = 30): void {
    if (!this.enabled) return;
    
    const cutoff = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    let cleaned = 0;

    for (const [username, record] of this.storage.entries()) {
      // Filter out old IP records
      record.ips = record.ips.filter(ip => ip.lastSeen > cutoff);
      
      // Remove player if no IPs left
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
