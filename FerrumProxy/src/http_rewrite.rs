use crate::config::ProxyTarget;
use std::io::{Cursor, Read, Write};

use flate2::read::{DeflateDecoder, GzDecoder, ZlibDecoder};
use flate2::write::{GzEncoder, ZlibEncoder};
use flate2::Compression;

const HTTP_METHODS: &[&str] = &[
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT",
];

pub fn is_likely_http_request(buf: &[u8]) -> bool {
    let head_end = header_end(buf).unwrap_or(buf.len().min(128));
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let first_line = head.split("\r\n").next().unwrap_or_default();
    let method = first_line.split(' ').next().unwrap_or_default();
    HTTP_METHODS.contains(&method)
}

pub fn rewrite_http_request(buf: &[u8], target: &ProxyTarget, forwarded_proto: &str) -> Vec<u8> {
    let Some(head_end) = header_end(buf) else {
        return buf.to_vec();
    };

    let head = String::from_utf8_lossy(&buf[..head_end]);
    let body = &buf[head_end + 4..];
    let mut lines = head.split("\r\n");
    let Some(request_line) = lines.next() else {
        return buf.to_vec();
    };

    let parts = request_line.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 3 || !parts[2].starts_with("HTTP/1.") {
        return buf.to_vec();
    }

    let rewritten_target = normalize_proxy_path(target.url_base_path.as_deref(), parts[1]);
    let mut rewritten = vec![format!("{} {} {}", parts[0], rewritten_target, parts[2])];
    let mut host_seen = false;
    let mut original_host = None;

    for line in lines {
        if line.to_ascii_lowercase().starts_with("host:") {
            host_seen = true;
            original_host = Some(line[5..].trim().to_string());
            rewritten.push(format!("Host: {}", target.host));
        } else {
            rewritten.push(line.to_string());
        }
    }

    if !host_seen {
        rewritten.push(format!("Host: {}", target.host));
    }
    if let Some(host) = original_host {
        if !rewritten
            .iter()
            .any(|line| line.to_ascii_lowercase().starts_with("x-forwarded-host:"))
        {
            rewritten.push(format!("X-Forwarded-Host: {host}"));
        }
    }
    if !rewritten
        .iter()
        .any(|line| line.to_ascii_lowercase().starts_with("x-forwarded-proto:"))
    {
        rewritten.push(format!("X-Forwarded-Proto: {forwarded_proto}"));
    }

    let mut out = rewritten.join("\r\n").into_bytes();
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(body);
    out
}

pub fn rewrite_http_response(buf: &[u8], target: &ProxyTarget) -> Vec<u8> {
    let Some(protocol) = target.url_protocol.as_deref() else {
        return buf.to_vec();
    };
    let Some(head_end) = header_end(buf) else {
        return buf.to_vec();
    };

    let head = String::from_utf8_lossy(&buf[..head_end]);
    let body = &buf[head_end + 4..];
    let origin = format!("{protocol}://{}", target.host);
    let base_path = target
        .url_base_path
        .as_deref()
        .filter(|path| *path != "/")
        .unwrap_or("");
    let origin_with_base = format!("{origin}{base_path}");

    let mut lines = head.split("\r\n").map(ToString::to_string).collect::<Vec<_>>();
    if lines.is_empty() {
        return buf.to_vec();
    }
    let status_line = lines.remove(0);

    for line in &mut lines {
        if !line.to_ascii_lowercase().starts_with("location:") {
            continue;
        }
        let location = line[9..].trim();
        if location == origin_with_base || location == format!("{origin_with_base}/") {
            *line = "Location: /".to_string();
            continue;
        }
        if !base_path.is_empty() && location.starts_with(&format!("{origin_with_base}/")) {
            *line = format!("Location: {}", &location[origin_with_base.len()..]);
            continue;
        }
        if location == origin {
            *line = format!(
                "Location: {}",
                if base_path.is_empty() { "/" } else { base_path }
            );
            continue;
        }
        *line = format!("Location: {location}");
    }

    let content_type = header_value(&lines, "content-type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let transfer_encoding = header_value(&lines, "transfer-encoding")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let content_encoding = header_value(&lines, "content-encoding")
        .unwrap_or("identity")
        .trim()
        .to_ascii_lowercase();
    let is_chunked = transfer_encoding.contains("chunked");
    let is_text_like = content_type.starts_with("text/")
        || content_type.contains("javascript")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("svg");

    let mut rewritten_body = body.to_vec();
    if !body.is_empty() && !is_chunked && is_text_like {
        if let Some(decoded) = decode_body(body, &content_encoding) {
            let mut rewritten_text = String::from_utf8_lossy(&decoded).into_owned();
            if !base_path.is_empty() {
                rewritten_text = rewritten_text.replace(&format!("{origin_with_base}/"), "/");
                rewritten_text = rewritten_text.replace(&origin_with_base, "/");
            }
            rewritten_text = rewritten_text.replace(&format!("{origin}/"), "/");
            rewritten_text = rewritten_text.replace(&origin, "/");

            if rewritten_text.as_bytes() != decoded.as_slice() {
                if let Some(encoded) = encode_body(rewritten_text.as_bytes(), &content_encoding) {
                    rewritten_body = encoded;
                    set_header_value(&mut lines, "Content-Length", &rewritten_body.len().to_string());
                }
            }
        }
    }

    let mut out = status_line.into_bytes();
    if !lines.is_empty() {
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(lines.join("\r\n").as_bytes());
    }
    out.extend_from_slice(b"\r\n\r\n");
    out.extend_from_slice(&rewritten_body);
    out
}

pub fn expected_response_total_len_if_rewrite_needed(buf: &[u8], target: &ProxyTarget) -> Option<usize> {
    if target.url_protocol.is_none() {
        return None;
    }
    let head_end = header_end(buf)?;
    let head = String::from_utf8_lossy(&buf[..head_end]);
    let lines = head
        .split("\r\n")
        .skip(1)
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let content_type = header_value(&lines, "content-type")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let transfer_encoding = header_value(&lines, "transfer-encoding")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if transfer_encoding.contains("chunked") {
        return None;
    }
    let is_text_like = content_type.starts_with("text/")
        || content_type.contains("javascript")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("svg");
    if !is_text_like {
        return None;
    }
    let content_encoding = header_value(&lines, "content-encoding")
        .unwrap_or("identity")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        content_encoding.as_str(),
        "" | "identity" | "gzip" | "x-gzip" | "deflate" | "br"
    ) {
        return None;
    }
    let content_length = header_value(&lines, "content-length")?.trim().parse::<usize>().ok()?;
    Some(head_end + 4 + content_length)
}

fn normalize_proxy_path(base_path: Option<&str>, request_target: &str) -> String {
    if request_target.starts_with("http://") || request_target.starts_with("https://") {
        if let Ok(parsed) = url::Url::parse(request_target) {
            return normalize_proxy_path(
                base_path,
                &format!(
                    "{}{}",
                    parsed.path(),
                    parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
                ),
            );
        }
    }

    let (path_part, query_part) = request_target
        .split_once('?')
        .map_or((request_target, None), |(path, query)| (path, Some(query)));
    if !path_part.starts_with('/') {
        return request_target.to_string();
    }

    let normalized_base = base_path
        .filter(|path| *path != "/")
        .map(|path| path.trim_end_matches('/'))
        .unwrap_or("");

    let rewritten_path = if !normalized_base.is_empty()
        && path_part != normalized_base
        && !path_part.starts_with(&format!("{normalized_base}/"))
    {
        if path_part == "/" {
            format!("{normalized_base}/")
        } else {
            format!("{normalized_base}{path_part}")
        }
    } else {
        path_part.to_string()
    };

    match query_part {
        Some(query) => format!("{rewritten_path}?{query}"),
        None => rewritten_path,
    }
}

fn header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

fn header_value<'a>(lines: &'a [String], name: &str) -> Option<&'a str> {
    lines.iter().find_map(|line| {
        let (header, value) = line.split_once(':')?;
        if header.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

fn set_header_value(lines: &mut Vec<String>, name: &str, value: &str) {
    let mut replaced = false;
    let mut out = Vec::with_capacity(lines.len() + 1);
    for line in lines.iter() {
        if let Some((header, _)) = line.split_once(':') {
            if header.trim().eq_ignore_ascii_case(name) {
                if !replaced {
                    out.push(format!("{name}: {value}"));
                    replaced = true;
                }
                continue;
            }
        }
        out.push(line.clone());
    }
    if !replaced {
        out.push(format!("{name}: {value}"));
    }
    *lines = out;
}

fn decode_body(body: &[u8], encoding: &str) -> Option<Vec<u8>> {
    match encoding {
        "" | "identity" => Some(body.to_vec()),
        "gzip" | "x-gzip" => {
            let mut decoder = GzDecoder::new(Cursor::new(body));
            let mut out = Vec::new();
            decoder.read_to_end(&mut out).ok()?;
            Some(out)
        }
        "deflate" => {
            let mut out = Vec::new();
            let zlib_attempt = {
                let mut decoder = ZlibDecoder::new(Cursor::new(body));
                decoder.read_to_end(&mut out)
            };
            if zlib_attempt.is_ok() {
                return Some(out);
            }

            let mut raw_out = Vec::new();
            let mut raw_decoder = DeflateDecoder::new(Cursor::new(body));
            raw_decoder.read_to_end(&mut raw_out).ok()?;
            Some(raw_out)
        }
        "br" => {
            let mut decoder = brotli::Decompressor::new(Cursor::new(body), 4096);
            let mut out = Vec::new();
            decoder.read_to_end(&mut out).ok()?;
            Some(out)
        }
        _ => None,
    }
}

fn encode_body(body: &[u8], encoding: &str) -> Option<Vec<u8>> {
    match encoding {
        "" | "identity" => Some(body.to_vec()),
        "gzip" | "x-gzip" => {
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(body).ok()?;
            encoder.finish().ok()
        }
        "deflate" => {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(body).ok()?;
            encoder.finish().ok()
        }
        "br" => {
            let mut writer = brotli::CompressorWriter::new(Vec::new(), 4096, 5, 22);
            writer.write_all(body).ok()?;
            writer.flush().ok()?;
            Some(writer.into_inner())
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> ProxyTarget {
        ProxyTarget {
            host: "gamelist1990.github.io".to_string(),
            tcp: Some(443),
            udp: Some(443),
            url_protocol: Some("https".to_string()),
            url_base_path: Some("/PEXServerWebSite".to_string()),
            original_url: None,
        }
    }

    #[test]
    fn rewrites_absolute_links_in_html_body() {
        let html = r#"<a href="https://gamelist1990.github.io/PEXServerWebSite/docs/start">Docs</a>"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{}",
            html.len(),
            html
        );
        let rewritten = rewrite_http_response(response.as_bytes(), &target());
        let text = String::from_utf8_lossy(&rewritten);
        assert!(text.contains(r#"href="/docs/start""#));
        assert!(!text.contains("https://gamelist1990.github.io/PEXServerWebSite"));
    }

    #[test]
    fn rewrites_gzip_html_body_and_updates_content_length() {
        let html = r#"<script src="https://gamelist1990.github.io/PEXServerWebSite/assets/app.js"></script>"#;
        let gzip_body = encode_body(html.as_bytes(), "gzip").expect("gzip encode");
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n",
            gzip_body.len()
        )
        .into_bytes();
        response.extend_from_slice(&gzip_body);

        let rewritten = rewrite_http_response(&response, &target());
        let head_end = header_end(&rewritten).expect("header end");
        let headers = String::from_utf8_lossy(&rewritten[..head_end]);
        let body = &rewritten[head_end + 4..];
        let decoded = decode_body(body, "gzip").expect("gzip decode");
        let decoded_text = String::from_utf8_lossy(&decoded);

        assert!(headers.contains("Content-Encoding: gzip"));
        assert!(headers.contains(&format!("Content-Length: {}", body.len())));
        assert!(decoded_text.contains(r#"<script src="/assets/app.js"></script>"#));
        assert!(!decoded_text.contains("https://gamelist1990.github.io/PEXServerWebSite"));
    }

    #[test]
    fn detects_full_response_length_for_rewriteable_payloads() {
        let html = r#"<a href="https://gamelist1990.github.io/PEXServerWebSite/">x</a>"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\r\n{}",
            html.len(),
            html
        );
        let expected = expected_response_total_len_if_rewrite_needed(response.as_bytes(), &target());
        assert_eq!(expected, Some(response.len()));
    }
}
