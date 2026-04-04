import type { ProxyTarget } from './proxyTypes.js';

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
  const body = buffer.subarray(headerEnd + 4);
  const origin = `${target.urlProtocol}://${target.host}`;
  const basePath = target.urlBasePath && target.urlBasePath !== '/' ? target.urlBasePath : '';
  const originWithBase = `${origin}${basePath}`;

  const rewrittenHead = head.replace(/^Location:\s*(.+)$/gim, (_line, rawLocation: string) => {
    const location = rawLocation.trim();
    if (location === originWithBase) {
      return 'Location: /';
    }
    if (location === `${originWithBase}/`) {
      return 'Location: /';
    }
    if (basePath !== '' && location.startsWith(`${originWithBase}/`)) {
      return `Location: ${location.slice(originWithBase.length)}`;
    }
    if (location === origin) {
      return `Location: ${basePath || '/'}`;
    }
    return `Location: ${location}`;
  });

  return Buffer.concat([Buffer.from(`${rewrittenHead}\r\n\r\n`, 'latin1'), body]);
}
