import type { ProxyTarget } from './proxyTypes.js';
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from 'zlib';

const HTTP_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'CONNECT',
]);

function getHeaderEndIndex(buffer: Buffer) {
  return buffer.indexOf('\r\n\r\n');
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProxyPath(basePath: string | undefined, requestTarget: string) {
  const [pathPartRaw, queryPart] = requestTarget.split('?', 2);
  let pathPart = pathPartRaw || '/';

  if (/^https?:\/\//i.test(pathPart)) {
    try {
      const parsed = new URL(requestTarget);
      pathPart = parsed.pathname || '/';
      return normalizeProxyPath(basePath, `${pathPart}${parsed.search}`);
    } catch {
      return requestTarget;
    }
  }

  if (!pathPart.startsWith('/')) {
    return requestTarget;
  }

  const normalizedBase = basePath && basePath !== '/'
    ? basePath.endsWith('/')
      ? basePath.slice(0, -1)
      : basePath
    : '';

  let rewrittenPath = pathPart;
  if (normalizedBase !== '' && pathPart !== normalizedBase && !pathPart.startsWith(`${normalizedBase}/`)) {
    rewrittenPath = pathPart === '/' ? `${normalizedBase}/` : `${normalizedBase}${pathPart}`;
  }

  return queryPart === undefined ? rewrittenPath : `${rewrittenPath}?${queryPart}`;
}

export function isLikelyHttpRequest(buffer: Buffer) {
  const headerEnd = getHeaderEndIndex(buffer);
  const head = buffer.subarray(0, headerEnd >= 0 ? headerEnd : Math.min(buffer.length, 128)).toString('latin1');
  const firstLine = head.split('\r\n', 1)[0] ?? '';
  const [method] = firstLine.split(' ', 1);
  return HTTP_METHODS.has(method ?? '');
}

export function rewriteHttpRequest(buffer: Buffer, target: ProxyTarget, forwardedProto: 'http' | 'https' = 'http') {
  const headerEnd = getHeaderEndIndex(buffer);
  if (headerEnd < 0) {
    return buffer;
  }

  const head = buffer.subarray(0, headerEnd).toString('latin1');
  const body = buffer.subarray(headerEnd + 4);
  const lines = head.split('\r\n');
  const requestLine = lines.shift();
  if (!requestLine) {
    return buffer;
  }

  const match = requestLine.match(/^([A-Z]+)\s+(\S+)\s+(HTTP\/1\.[01])$/);
  if (!match) {
    return buffer;
  }

  const [, method, requestTarget, version] = match;
  const rewrittenTarget = normalizeProxyPath(target.urlBasePath, requestTarget);
  const rewrittenLines: string[] = [`${method} ${rewrittenTarget} ${version}`];
  let hostSeen = false;
  let originalHost: string | undefined;

  for (const line of lines) {
    if (/^host\s*:/i.test(line)) {
      hostSeen = true;
      originalHost = line.replace(/^host\s*:/i, '').trim();
      rewrittenLines.push(`Host: ${target.host}`);
      continue;
    }

    rewrittenLines.push(line);
  }

  if (!hostSeen) {
    rewrittenLines.push(`Host: ${target.host}`);
  }
  if (originalHost && !rewrittenLines.some((line) => /^x-forwarded-host\s*:/i.test(line))) {
    rewrittenLines.push(`X-Forwarded-Host: ${originalHost}`);
  }
  if (!rewrittenLines.some((line) => /^x-forwarded-proto\s*:/i.test(line))) {
    rewrittenLines.push(`X-Forwarded-Proto: ${forwardedProto}`);
  }

  const rewrittenHead = `${rewrittenLines.join('\r\n')}\r\n\r\n`;
  return Buffer.concat([Buffer.from(rewrittenHead, 'latin1'), body]);
}

export function rewriteHttpResponse(buffer: Buffer, target: ProxyTarget) {
  const headerEnd = getHeaderEndIndex(buffer);
  if (headerEnd < 0 || !target.urlProtocol) {
    return buffer;
  }

  const head = buffer.subarray(0, headerEnd).toString('latin1');
  const originalBody = buffer.subarray(headerEnd + 4);
  const headLines = head.split('\r\n');
  const statusLine = headLines.shift();
  if (!statusLine) {
    return buffer;
  }
  const lines = headLines.slice();
  const origin = `${target.urlProtocol}://${target.host}`;
  const basePath = target.urlBasePath && target.urlBasePath !== '/' ? target.urlBasePath : '';
  const originWithBase = `${origin}${basePath}`;

  const rewriteLocationValue = (rawLocation: string) => {
    const location = rawLocation.trim();
    if (location === originWithBase) {
      return '/';
    }
    if (location === `${originWithBase}/`) {
      return '/';
    }
    if (basePath !== '' && location.startsWith(`${originWithBase}/`)) {
      return location.slice(originWithBase.length);
    }
    if (location === origin) {
      return basePath || '/';
    }
    return location;
  };

  const getHeaderValue = (name: string) => {
    const lower = name.toLowerCase();
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator < 0) {
        continue;
      }
      if (line.slice(0, separator).trim().toLowerCase() === lower) {
        return line.slice(separator + 1).trim();
      }
    }
    return undefined as string | undefined;
  };

  const setHeaderValue = (name: string, value: string) => {
    const lower = name.toLowerCase();
    let replaced = false;
    const filtered: string[] = [];
    for (const line of lines) {
      const separator = line.indexOf(':');
      if (separator < 0) {
        filtered.push(line);
        continue;
      }
      if (line.slice(0, separator).trim().toLowerCase() === lower) {
        if (!replaced) {
          filtered.push(`${name}: ${value}`);
          replaced = true;
        }
        continue;
      }
      filtered.push(line);
    }
    if (!replaced) {
      filtered.push(`${name}: ${value}`);
    }
    lines.length = 0;
    lines.push(...filtered);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^location\s*:/i.test(line)) {
      continue;
    }
    const location = line.replace(/^location\s*:/i, '').trim();
    lines[i] = `Location: ${rewriteLocationValue(location)}`;
  }

  const contentType = getHeaderValue('Content-Type')?.toLowerCase() ?? '';
  const transferEncoding = getHeaderValue('Transfer-Encoding')?.toLowerCase() ?? '';
  const contentEncoding = (getHeaderValue('Content-Encoding') ?? 'identity').toLowerCase();
  const isChunked = transferEncoding.includes('chunked');
  const isTextLike = contentType.startsWith('text/')
    || contentType.includes('javascript')
    || contentType.includes('json')
    || contentType.includes('xml')
    || contentType.includes('svg');
  const canRewriteBody = originalBody.length > 0 && !isChunked && isTextLike;

  const decodeBody = (body: Buffer) => {
    try {
      if (contentEncoding === 'identity' || contentEncoding === '') {
        return body;
      }
      if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
        return gunzipSync(body);
      }
      if (contentEncoding === 'deflate') {
        try {
          return inflateSync(body);
        } catch {
          return inflateRawSync(body);
        }
      }
      if (contentEncoding === 'br') {
        return brotliDecompressSync(body);
      }
    } catch {
      return null;
    }
    return null;
  };

  const encodeBody = (body: Buffer) => {
    try {
      if (contentEncoding === 'identity' || contentEncoding === '') {
        return body;
      }
      if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
        return gzipSync(body);
      }
      if (contentEncoding === 'deflate') {
        return deflateSync(body);
      }
      if (contentEncoding === 'br') {
        return brotliCompressSync(body);
      }
    } catch {
      return null;
    }
    return null;
  };

  let rewrittenBody = originalBody;
  if (canRewriteBody) {
    const decodedBody = decodeBody(originalBody);
    if (decodedBody) {
      const decodedText = decodedBody.toString('utf8');
      let bodyText = decodedText;
      if (basePath !== '') {
        bodyText = bodyText
          .replace(new RegExp(`${escapeRegex(originWithBase)}/`, 'g'), '/')
          .replace(new RegExp(`${escapeRegex(originWithBase)}(?=["'\\s<>]|$)`, 'g'), '/');
      }
      bodyText = bodyText
        .replace(new RegExp(`${escapeRegex(origin)}/`, 'g'), '/')
        .replace(new RegExp(`${escapeRegex(origin)}(?=["'\\s<>]|$)`, 'g'), '/');

      if (bodyText !== decodedText) {
        const reEncoded = encodeBody(Buffer.from(bodyText, 'utf8'));
        if (reEncoded) {
          rewrittenBody = reEncoded;
          setHeaderValue('Content-Length', String(rewrittenBody.length));
        }
      }
    }
  }

  const rewrittenHead = `${statusLine}\r\n${lines.join('\r\n')}`;
  return Buffer.concat([Buffer.from(`${rewrittenHead}\r\n\r\n`, 'latin1'), rewrittenBody]);
}
