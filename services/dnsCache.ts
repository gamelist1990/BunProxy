import dns from 'dns';
import net from 'net';

const DEFAULT_DNS_CACHE_TTL_MS = 60_000;

type CachedAddress = {
  address: string;
  expiresAt: number;
};

const cache = new Map<string, CachedAddress>();

export async function resolveHostnameCached(
  host: string,
  ttlMs = DEFAULT_DNS_CACHE_TTL_MS,
): Promise<string> {
  if (net.isIP(host) !== 0) {
    return host;
  }

  const now = Date.now();
  const cached = cache.get(host);
  if (cached && cached.expiresAt > now) {
    return cached.address;
  }

  const addr = await dns.promises.lookup(host);
  cache.set(host, {
    address: addr.address,
    expiresAt: now + ttlMs,
  });
  return addr.address;
}

export function clearDnsCache() {
  cache.clear();
}
