use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::time::timeout;
use tracing::{debug, error, info, warn};

use crate::bedrock::{
    is_disconnect_notification, is_offline_ping, is_unconnected_pong,
    rewrite_unconnected_pong_ports, rewrite_unconnected_pong_timestamp,
};
use crate::config::{ListenerRule, Protocol, ProxyTarget};
use crate::dns_cache::DnsCache;
use crate::proxy_protocol::{build_proxy_v2_header, parse_proxy_chain};
use crate::runtime::AppRuntime;

const UDP_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const BEDROCK_PONG_CACHE_TTL: Duration = Duration::from_secs(2);
const MAX_DATAGRAM_SIZE: usize = 65_535;

type SessionMap = Arc<Mutex<HashMap<SocketAddr, UdpSession>>>;
type PongCache = Arc<Mutex<HashMap<String, CachedPong>>>;

#[derive(Clone)]
struct UdpSession {
    socket: Arc<UdpSocket>,
    active_target_index: usize,
    header_sent: bool,
    notified: bool,
}

struct CachedPong {
    payload: Vec<u8>,
    expires_at: Instant,
}

pub async fn start_udp_proxy(
    rule: Arc<ListenerRule>,
    dns_cache: Arc<DnsCache>,
    runtime: Arc<AppRuntime>,
) -> Result<()> {
    let port = rule.udp.context("UDP listener missing port")?;
    let bind = format!("{}:{port}", rule.bind);
    let server = Arc::new(
        UdpSocket::bind(&bind)
            .await
            .with_context(|| format!("failed to bind UDP listener {bind}"))?,
    );
    let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));
    let pong_cache: PongCache = Arc::new(Mutex::new(HashMap::new()));

    info!("UDP listening on {bind}");

    let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
    loop {
        let (len, peer) = server.recv_from(&mut buf).await?;
        let packet = buf[..len].to_vec();
        let server = Arc::clone(&server);
        let sessions = Arc::clone(&sessions);
        let pong_cache = Arc::clone(&pong_cache);
        let rule = Arc::clone(&rule);
        let dns_cache = Arc::clone(&dns_cache);
        let runtime = Arc::clone(&runtime);

        tokio::spawn(async move {
            if let Err(err) = handle_datagram(
                server, sessions, pong_cache, rule, dns_cache, runtime, peer, packet,
            )
            .await
            {
                warn!("UDP datagram from {peer} failed: {err:#}");
            }
        });
    }
}

async fn handle_datagram(
    server: Arc<UdpSocket>,
    sessions: SessionMap,
    pong_cache: PongCache,
    rule: Arc<ListenerRule>,
    dns_cache: Arc<DnsCache>,
    runtime: Arc<AppRuntime>,
    peer: SocketAddr,
    packet: Vec<u8>,
) -> Result<()> {
    let mut original_client = peer;
    let parsed =
        parse_proxy_chain(&packet).unwrap_or_else(|_| crate::proxy_protocol::ParsedProxyChain {
            headers: Vec::new(),
            payload_offset: 0,
        });
    if let Some(last_header) = parsed.headers.last() {
        original_client = SocketAddr::new(last_header.source_address, last_header.source_port);
        debug!(
            "UDP incoming PROXY header original={} destination={}:{}",
            original_client, last_header.destination_address, last_header.destination_port
        );
    }
    let payload = packet[parsed.payload_offset..].to_vec();

    if payload.is_empty() {
        return Ok(());
    }

    if is_offline_ping(&payload) {
        if let Some(cached) = get_cached_pong(&pong_cache, &target_cache_key(&rule, 0)).await {
            let response = rewrite_unconnected_pong_timestamp(&cached, &payload[1..9]);
            server.send_to(&response, peer).await?;
            debug!("UDP served shared cached Bedrock pong to {peer}");
            return Ok(());
        }
    }

    let mut session = {
        let guard = sessions.lock().await;
        guard.get(&peer).cloned()
    };

    if session.is_none() {
        session = Some(
            create_session(
                Arc::clone(&server),
                Arc::clone(&sessions),
                Arc::clone(&pong_cache),
                Arc::clone(&rule),
                Arc::clone(&runtime),
                peer,
            )
            .await?,
        );
    }

    let mut session = session.context("failed to create UDP session")?;

    if is_disconnect_notification(&payload) {
        sessions.lock().await.remove(&peer);
        debug!("UDP session closed by disconnect notification {peer}");
        return Ok(());
    }

    if is_offline_ping(&payload) {
        if let Some(cached) = get_cached_pong(
            &pong_cache,
            &target_cache_key(&rule, session.active_target_index),
        )
        .await
        {
            let response = rewrite_unconnected_pong_timestamp(&cached, &payload[1..9]);
            server.send_to(&response, peer).await?;
            debug!("UDP served session cached Bedrock pong to {peer}");
            return Ok(());
        }
    }

    try_send_udp(&rule, dns_cache, &mut session, original_client, &payload).await?;
    if !session.notified {
        maybe_notify_connect(&runtime, &rule, &session, original_client).await;
        session.notified = true;
    }
    sessions.lock().await.insert(peer, session);
    Ok(())
}

async fn create_session(
    server: Arc<UdpSocket>,
    sessions: SessionMap,
    pong_cache: PongCache,
    rule: Arc<ListenerRule>,
    runtime: Arc<AppRuntime>,
    peer: SocketAddr,
) -> Result<UdpSession> {
    let socket = Arc::new(
        UdpSocket::bind(if peer.is_ipv6() {
            "[::]:0"
        } else {
            "0.0.0.0:0"
        })
        .await?,
    );
    let recv_socket = Arc::clone(&socket);
    let send_server = Arc::clone(&server);
    let recv_sessions = Arc::clone(&sessions);
    let recv_cache = Arc::clone(&pong_cache);
    let recv_rule = Arc::clone(&rule);
    let recv_runtime = Arc::clone(&runtime);

    tokio::spawn(async move {
        let mut buf = vec![0u8; MAX_DATAGRAM_SIZE];
        loop {
            match timeout(UDP_SESSION_IDLE_TIMEOUT, recv_socket.recv_from(&mut buf)).await {
                Ok(Ok((len, backend_addr))) => {
                    let mut response = buf[..len].to_vec();
                    if let Ok(parsed) = parse_proxy_chain(&response) {
                        if !parsed.headers.is_empty() {
                            response = response[parsed.payload_offset..].to_vec();
                        }
                    }

                    if recv_rule.rewrite_bedrock_pong_ports {
                        if let Some(rewritten) = rewrite_unconnected_pong_ports(
                            &response,
                            recv_rule.udp.unwrap_or_default(),
                        ) {
                            response = rewritten;
                        }
                    }

                    if is_unconnected_pong(&response) {
                        let target_index = recv_sessions
                            .lock()
                            .await
                            .get(&peer)
                            .map(|session| session.active_target_index)
                            .unwrap_or(0);
                        set_cached_pong(
                            &recv_cache,
                            target_cache_key(&recv_rule, target_index),
                            &response,
                        )
                        .await;
                    }

                    if let Err(err) = send_server.send_to(&response, peer).await {
                        error!("UDP response send to {peer} failed: {err}");
                        break;
                    }
                    debug!("UDP {backend_addr} -> {peer} {}B", response.len());
                }
                Ok(Err(err)) => {
                    error!("UDP backend socket for {peer} failed: {err}");
                    break;
                }
                Err(_) => {
                    debug!("UDP session idle timeout {peer}");
                    maybe_notify_disconnect(&recv_runtime, &recv_rule, peer).await;
                    break;
                }
            }
        }

        recv_sessions.lock().await.remove(&peer);
    });

    let session = UdpSession {
        socket,
        active_target_index: 0,
        header_sent: false,
        notified: false,
    };
    sessions.lock().await.insert(peer, session.clone());
    Ok(session)
}

async fn maybe_notify_connect(
    runtime: &AppRuntime,
    rule: &ListenerRule,
    session: &UdpSession,
    client_addr: SocketAddr,
) {
    let Some(webhook) = rule
        .webhook
        .as_deref()
        .filter(|webhook| !webhook.trim().is_empty())
    else {
        return;
    };

    let targets = rule.targets_for(Protocol::Udp);
    let Some(target) = targets
        .get(session.active_target_index)
        .or_else(|| targets.first())
    else {
        return;
    };
    let target_key = format!("{}:{}", target.host, target.udp.unwrap_or_default());

    if runtime.use_rest_api {
        runtime
            .connection_buffer
            .add_pending(
                client_addr.ip().to_string(),
                client_addr.port(),
                "UDP",
                target_key,
            )
            .await;
    } else {
        runtime
            .notifier
            .add_connect_group(
                webhook.to_string(),
                target_key,
                client_addr.ip().to_string(),
                client_addr.port(),
                "UDP",
            )
            .await;
    }
}

async fn maybe_notify_disconnect(
    runtime: &AppRuntime,
    rule: &ListenerRule,
    client_addr: SocketAddr,
) {
    if runtime.use_rest_api {
        return;
    }
    let Some(webhook) = rule
        .webhook
        .as_deref()
        .filter(|webhook| !webhook.trim().is_empty())
    else {
        return;
    };
    let targets = rule.targets_for(Protocol::Udp);
    let Some(target) = targets.first() else {
        return;
    };
    runtime
        .notifier
        .add_disconnect_group(
            webhook.to_string(),
            format!("{}:{}", target.host, target.udp.unwrap_or_default()),
            client_addr.ip().to_string(),
            client_addr.port(),
            "UDP",
        )
        .await;
}

async fn try_send_udp(
    rule: &ListenerRule,
    dns_cache: Arc<DnsCache>,
    session: &mut UdpSession,
    original_client: SocketAddr,
    payload: &[u8],
) -> Result<()> {
    let targets = rule.targets_for(Protocol::Udp);
    let force_proxy_header = rule.haproxy && is_offline_ping(payload);
    let mut last_error = None;

    for index in session.active_target_index..targets.len() {
        let target = &targets[index];
        let Some(target_port) = target.udp else {
            continue;
        };

        match send_to_target(
            rule,
            dns_cache.as_ref(),
            session,
            original_client,
            payload,
            target,
            target_port,
            index,
            force_proxy_header,
        )
        .await
        {
            Ok(()) => {
                session.active_target_index = index;
                return Ok(());
            }
            Err(err) => {
                last_error = Some(err);
                session.header_sent = false;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("all UDP targets failed")))
}

async fn send_to_target(
    rule: &ListenerRule,
    dns_cache: &DnsCache,
    session: &mut UdpSession,
    original_client: SocketAddr,
    payload: &[u8],
    target: &ProxyTarget,
    target_port: u16,
    target_index: usize,
    force_proxy_header: bool,
) -> Result<()> {
    let target_ip = dns_cache.resolve(&target.host).await?;
    let target_addr = SocketAddr::new(target_ip, target_port);
    let mut out = payload.to_vec();

    if rule.haproxy && (force_proxy_header || !session.header_sent) {
        let header = build_proxy_v2_header(
            original_client.ip(),
            original_client.port(),
            target_ip,
            target_port,
            true,
        );
        out = [header, out].concat();

        if !is_offline_ping(payload) {
            session.header_sent = true;
        }
    }

    session.socket.send_to(&out, target_addr).await?;
    session.active_target_index = target_index;
    debug!("UDP {original_client} -> {target_addr} {}B", out.len());
    Ok(())
}

async fn get_cached_pong(cache: &PongCache, key: &str) -> Option<Vec<u8>> {
    let mut guard = cache.lock().await;
    let cached = guard.get(key)?;
    if cached.expires_at <= Instant::now() {
        guard.remove(key);
        return None;
    }
    Some(cached.payload.clone())
}

async fn set_cached_pong(cache: &PongCache, key: String, payload: &[u8]) {
    cache.lock().await.insert(
        key,
        CachedPong {
            payload: payload.to_vec(),
            expires_at: Instant::now() + BEDROCK_PONG_CACHE_TTL,
        },
    );
}

fn target_cache_key(rule: &ListenerRule, target_index: usize) -> String {
    let targets = rule.targets_for(Protocol::Udp);
    match targets.get(target_index).or_else(|| targets.first()) {
        Some(target) => format!("{}:{}", target.host, target.udp.unwrap_or_default()),
        None => "none:0".to_string(),
    }
}
