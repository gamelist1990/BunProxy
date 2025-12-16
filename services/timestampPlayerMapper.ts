
export class TimestampPlayerMapper {
  private playerMap: Map<number, { username: string; timestamp: number }> = new Map();
  private readonly TIMESTAMP_TOLERANCE_MS = 30_000; // ±30 seconds tolerance

  registerLogin(timestamp: number, username: string): void {
    this.playerMap.set(timestamp, { username, timestamp });
    console.log(`[PlayerMapper] Registered login: ${username} at ${new Date(timestamp).toISOString()}`);
  }


  registerLogout(timestamp: number, username: string): void {
    for (const [key, value] of this.playerMap.entries()) {
      if (value.username === username && Math.abs(value.timestamp - timestamp) < this.TIMESTAMP_TOLERANCE_MS) {
        this.playerMap.delete(key);
        console.log(`[PlayerMapper] Registered logout: ${username} at ${new Date(timestamp).toISOString()}`);
        return;
      }
    }
  }


  findPlayerByTimestamp(connectionTimestamp: number): string | null {
    let bestMatch: { username: string; diff: number } | null = null;

    for (const [key, value] of this.playerMap.entries()) {
      const diff = Math.abs(connectionTimestamp - value.timestamp);

      if (diff < this.TIMESTAMP_TOLERANCE_MS) {
        if (!bestMatch || diff < bestMatch.diff) {
          bestMatch = { username: value.username, diff };
        }
      }
    }

    return bestMatch ? bestMatch.username : null;
  }


  getAllPlayers(): Array<{ username: string; timestamp: number; timestampStr: string }> {
    return Array.from(this.playerMap.values()).map((v) => ({
      ...v,
      timestampStr: new Date(v.timestamp).toISOString(),
    }));
  }


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
