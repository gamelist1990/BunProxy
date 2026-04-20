use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::sync::RwLock;

const DEFAULT_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
struct CachedAddress {
    address: IpAddr,
    expires_at: Instant,
}

#[derive(Debug, Default)]
pub struct DnsCache {
    entries: RwLock<HashMap<String, CachedAddress>>,
}

impl DnsCache {
    pub async fn resolve(&self, host: &str) -> Result<IpAddr> {
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(ip);
        }

        let now = Instant::now();
        if let Some(cached) = self.entries.read().await.get(host) {
            if cached.expires_at > now {
                return Ok(cached.address);
            }
        }

        let mut addrs = tokio::net::lookup_host((host, 0))
            .await
            .with_context(|| format!("failed to resolve {host}"))?;
        let address = addrs
            .next()
            .map(|socket_addr| socket_addr.ip())
            .with_context(|| format!("no addresses returned for {host}"))?;

        self.entries.write().await.insert(
            host.to_string(),
            CachedAddress {
                address,
                expires_at: now + DEFAULT_TTL,
            },
        );

        Ok(address)
    }
}
