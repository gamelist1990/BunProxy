const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d,0x0a,0x0d,0x0a,0x00,0x0d,0x0a,0x51,0x55,0x49,0x54,0x0a
]);

export interface ProxyV2Header {
  version: number;
  command: 'LOCAL' | 'PROXY';
  family: 'UNSPEC' | 'INET' | 'INET6' | 'UNIX';
  protocol: 'UNSPEC' | 'STREAM' | 'DGRAM';
  sourceAddress: string;
  destAddress: string;
  sourcePort: number;
  destPort: number;
  headerLength: number;
}

export function isProxyV2(data: Buffer): boolean {
  if (data.length < PROXY_V2_SIGNATURE.length) return false;
  return data.subarray(0, PROXY_V2_SIGNATURE.length).equals(PROXY_V2_SIGNATURE);
}

export function parseProxyV2(data: Buffer): ProxyV2Header | null {
  if (!isProxyV2(data)) return null;
  if (data.length < 16) return null;
  const versionAndCommand = data[12];
  const version = (versionAndCommand & 0xf0) >> 4;
  const commandBit = versionAndCommand & 0x0f;
  const command = commandBit === 0x01 ? 'PROXY' : 'LOCAL';
  const familyAndProtocol = data[13];
  const familyBit = (familyAndProtocol & 0xf0) >> 4;
  const protocolBit = familyAndProtocol & 0x0f;
  let family: ProxyV2Header['family'] = 'UNSPEC';
  if (familyBit === 0x1) family = 'INET';
  else if (familyBit === 0x2) family = 'INET6';
  else if (familyBit === 0x3) family = 'UNIX';
  let protocol: ProxyV2Header['protocol'] = 'UNSPEC';
  if (protocolBit === 0x1) protocol = 'STREAM';
  else if (protocolBit === 0x2) protocol = 'DGRAM';
  const addressLength = data.readUInt16BE(14);
  const totalHeaderLength = 16 + addressLength;
  if (data.length < totalHeaderLength) return null;
  let src = '';
  let dst = '';
  let srcPort = 0;
  let dstPort = 0;
  if (family === 'INET' && (protocol === 'STREAM' || protocol === 'DGRAM')) {
    if (addressLength >= 12) {
      src = `${data[16]}.${data[17]}.${data[18]}.${data[19]}`;
      dst = `${data[20]}.${data[21]}.${data[22]}.${data[23]}`;
      srcPort = data.readUInt16BE(24);
      dstPort = data.readUInt16BE(26);
    }
  } else if (family === 'INET6' && (protocol === 'STREAM' || protocol === 'DGRAM')) {
    if (addressLength >= 36) {
      const srcBuf = data.subarray(16, 32);
      const dstBuf = data.subarray(32, 48);
      src = formatIPv6(srcBuf);
      dst = formatIPv6(dstBuf);
      srcPort = data.readUInt16BE(48);
      dstPort = data.readUInt16BE(50);
    }
  }
  const parsed: ProxyV2Header = {
    version,
    command,
    family,
    protocol,
    sourceAddress: src,
    destAddress: dst,
    sourcePort: srcPort,
    destPort: dstPort,
    headerLength: totalHeaderLength,
  };

  try {
    console.log('[proxy-protocol-parser] parseProxyV2', {
      version: parsed.version,
      command: parsed.command,
      family: parsed.family,
      protocol: parsed.protocol,
      source: `${parsed.sourceAddress}:${parsed.sourcePort}`,
      dest: `${parsed.destAddress}:${parsed.destPort}`,
      headerLength: parsed.headerLength,
    });
  } catch (_) {}

  return parsed;
}

function formatIPv6(buf: Buffer): string {
  const parts = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(buf.readUInt16BE(i).toString(16));
  }
  return parts.join(':');
}

/**
 * Parse a chain of Proxy Protocol v2 headers, returning parsed headers and remaining payload.
 */
export function parseProxyV2Chain(data: Buffer): { headers: ProxyV2Header[]; payload: Buffer } {
  const headers: ProxyV2Header[] = [];
  let offset = 0;
  let iteration = 0;
  const MAX_ITER = 32;
  while (offset < data.length && iteration < MAX_ITER) {
    const chunk = data.subarray(offset);
    if (!isProxyV2(chunk)) break;
    const hdr = parseProxyV2(chunk);
    if (!hdr) break;
    headers.push(hdr);
    offset += hdr.headerLength;
    iteration++;
  }
  const payload = data.subarray(offset);

  if (headers.length > 0) {
    try {
      console.log('[proxy-protocol-parser] parsed chain', {
        layers: headers.length,
        headers: headers.map(h => ({
          family: h.family,
          protocol: h.protocol,
          source: `${h.sourceAddress}:${h.sourcePort}`,
          dest: `${h.destAddress}:${h.destPort}`,
          headerLength: h.headerLength,
        })),
        payloadLength: payload.length,
      });
    } catch (_) {}
  }

  return { headers, payload };
}

export function getOriginalClientFromHeaders(headers: ProxyV2Header[]): { ip: string, port: number } | null {
  if (!headers || headers.length === 0) return null;
  const last = headers[headers.length - 1];
  if (last && last.sourceAddress) {
    return { ip: last.sourceAddress, port: last.sourcePort };
  }
  return null;
}



//Proxy Protocol v2 Support 