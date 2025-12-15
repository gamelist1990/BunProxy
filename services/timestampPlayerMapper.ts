/**
 * Timestamp-based player mapping
 * Maps connection timestamp to player username
 */
export class TimestampPlayerMapper {
  private playerMap: Map<number, { username: string; timestamp: number }> = new Map();
  private readonly TIMESTAMP_TOLERANCE_MS = 30_000; // ±30 seconds tolerance

  /**
   * Register a player login with timestamp
   */
  registerLogin(timestamp: number, username: string): void {
    // Store with exact timestamp as key
    this.playerMap.set(timestamp, { username, timestamp });
    console.log(`[PlayerMapper] Registered login: ${username} at ${new Date(timestamp).toISOString()}`);
  }

  /**
   * Register a player logout
   */
  registerLogout(timestamp: number, username: string): void {
    // Find and remove entry matching username and timestamp
    for (const [key, value] of this.playerMap.entries()) {
      if (value.username === username && Math.abs(value.timestamp - timestamp) < this.TIMESTAMP_TOLERANCE_MS) {
        this.playerMap.delete(key);
        console.log(`[PlayerMapper] Registered logout: ${username} at ${new Date(timestamp).toISOString()}`);
        return;
      }
    }
  }

  /**
   * Find player by connection timestamp
   * Matches connection timestamp with login timestamp (within tolerance)
   */
  findPlayerByTimestamp(connectionTimestamp: number): string | null {
    // Find the closest matching timestamp within tolerance
    let bestMatch: { username: string; diff: number } | null = null;

    for (const [key, value] of this.playerMap.entries()) {
      const diff = Math.abs(connectionTimestamp - value.timestamp);
      
      if (diff < this.TIMESTAMP_TOLERANCE_MS) {
        // If no match yet, or this is closer than the best match
        if (!bestMatch || diff < bestMatch.diff) {
          bestMatch = { username: value.username, diff };
        }
      }
    }

    return bestMatch ? bestMatch.username : null;
  }

  /**
   * Get all currently tracked players
   */
  getAllPlayers(): Array<{ username: string; timestamp: number; timestampStr: string }> {
    return Array.from(this.playerMap.values()).map((v) => ({
      ...v,
      timestampStr: new Date(v.timestamp).toISOString(),
    }));
  }

  /**
   * Cleanup old entries (older than 5 minutes)
   */
  cleanup(): void {
    const now = Date.now();
    const MAX_AGE_MS = 5 * 60_000; // 5 minutes

    for (const [key, value] of this.playerMap.entries()) {
      if (now - value.timestamp > MAX_AGE_MS) {
        this.playerMap.delete(key);
      }
    }
  }
}
