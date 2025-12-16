/**
 * Pending connection buffer for REST API mode
 * Holds pending connections waiting for player name match
 */
export interface PendingConnection {
  ip: string;
  port: number;
  protocol: 'TCP' | 'UDP';
  timestamp: number;
  target: string;
  processCallback: (playerName?: string) => void;
}

export class ConnectionBuffer {
  private pending: Map<string, PendingConnection> = new Map();
  private readonly BUFFER_TIMEOUT_MS = 30_000; // 30 seconds

  /**
   * Add a pending connection
   */
  addPending(
    ip: string,
    port: number,
    protocol: 'TCP' | 'UDP',
    target: string,
    processCallback: (playerName?: string) => void
  ): string {
    const key = `${ip}:${port}:${protocol}`;
    const pending: PendingConnection = {
      ip,
      port,
      protocol,
      timestamp: Date.now(),
      target,
      processCallback,
    };

    this.pending.set(key, pending);

    // Auto-timeout if player name doesn't arrive
    setTimeout(() => {
      if (this.pending.has(key)) {
        console.log(`[Buffer] Timeout for pending connection ${key}`);
        const p = this.pending.get(key)!;
        this.pending.delete(key);
        p.processCallback(); // Process without player name
      }
    }, this.BUFFER_TIMEOUT_MS);

    return key;
  }

  /**
   * Process pending connection with player name
   */
  processPendingForPlayer(
    _playerName: string,
    timestamp: number
  ): { matched: PendingConnection[]; unmatched: PendingConnection[] } {
    const matched: PendingConnection[] = [];
    const unmatched: PendingConnection[] = [];
    const TOLERANCE_MS = 30_000; // ±30 seconds tolerance

    for (const [key, pending] of this.pending.entries()) {
      const timeDiff = Math.abs(pending.timestamp - timestamp);
      if (timeDiff < TOLERANCE_MS) {
        matched.push(pending);
        this.pending.delete(key);
      }
    }

    // Get all remaining pending connections for logging
    for (const pending of this.pending.values()) {
      unmatched.push(pending);
    }

    return { matched, unmatched };
  }

  /**
   * Get all pending connections
   */
  getPending(): PendingConnection[] {
    return Array.from(this.pending.values());
  }

  /**
   * Clear a specific pending connection
   */
  clearPending(ip: string, port: number, protocol: 'TCP' | 'UDP'): void {
    const key = `${ip}:${port}:${protocol}`;
    this.pending.delete(key);
  }
}
