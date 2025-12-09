import net from 'net';

// Proxy Protocol v2 Header builder
const PROXY_V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51,
  0x55, 0x49, 0x54, 0x0a
]);

/**
 * Generate a Proxy Protocol v2 header buffer.
 * @param sourceIP client IP
 * @param sourcePort client port
 * @param destIP destination IP
 * @param destPort destination port
 * @param isUDP true for DGRAM (UDP), false for STREAM (TCP)
 */
export function generateProxyProtocolV2Header(
  sourceIP: string,
  sourcePort: number,
  destIP: string,
  destPort: number,
  isUDP = false
): Buffer {
  sourceIP = normalizeMappedIPv4(sourceIP);
  destIP = normalizeMappedIPv4(destIP);
  const isIPv6 = net.isIP(sourceIP) === 6 || sourceIP.includes(':');

  // version 2, PROXY command
  const versionAndCommand = 0x21; // 0010 0001

  // family and protocol
  let familyBits = 0x10; // INET
  if (isIPv6) familyBits = 0x20; // INET6
  const protocolBits = isUDP ? 0x02 : 0x01; // DGRAM or STREAM
  const familyAndProtocol = familyBits | protocolBits;

  // build address buffer for IPv4/IPv6
  let addressBuffer: Buffer;
  if (isIPv6) {
    // IPv6 address buffer: 16 + 16 + 2 + 2 = 36
    addressBuffer = Buffer.alloc(36);
    const sourceParts = expandIPv6Parts(sourceIP);
    const destParts = expandIPv6Parts(destIP);
    for (let i = 0; i < 8; i++) {
      addressBuffer.writeUInt16BE(sourceParts[i] || 0, i * 2);
    }
    for (let i = 0; i < 8; i++) {
      addressBuffer.writeUInt16BE(destParts[i] || 0, 16 + i * 2);
    }
    addressBuffer.writeUInt16BE(sourcePort, 32);
    addressBuffer.writeUInt16BE(destPort, 34);
  } else {
    // IPv4: 4 + 4 + 2 + 2 = 12
    addressBuffer = Buffer.alloc(12);
    const srcParts = sourceIP.split('.').map(Number);
    const dstParts = destIP.split('.').map(Number);
    addressBuffer[0] = srcParts[0] || 0;
    addressBuffer[1] = srcParts[1] || 0;
    addressBuffer[2] = srcParts[2] || 0;
    addressBuffer[3] = srcParts[3] || 0;
    addressBuffer[4] = dstParts[0] || 0;
    addressBuffer[5] = dstParts[1] || 0;
    addressBuffer[6] = dstParts[2] || 0;
    addressBuffer[7] = dstParts[3] || 0;
    addressBuffer.writeUInt16BE(sourcePort, 8);
    addressBuffer.writeUInt16BE(destPort, 10);
  }

  const addressLength = addressBuffer.length;
  const header = Buffer.alloc(16 + addressLength);
  PROXY_V2_SIGNATURE.copy(header, 0);
  header[12] = versionAndCommand;
  header[13] = familyAndProtocol;
  header.writeUInt16BE(addressLength, 14);
  addressBuffer.copy(header, 16);
  return header;
}

function expandIPv6Parts(ip: string): number[] {
  // Expand shorthand omitting compression
  if (!ip.includes('::')) {
    return ip.split(':').map(x => parseInt(x || '0', 16));
  }
  const [left, right] = ip.split('::');
  const leftParts = left ? left.split(':').map(x => parseInt(x || '0', 16)) : [];
  const rightParts = right ? right.split(':').map(x => parseInt(x || '0', 16)) : [];
  const missing = 8 - (leftParts.length + rightParts.length);
  const parts = [...leftParts];
  for (let i = 0; i < missing; i++) parts.push(0);
  for (const p of rightParts) parts.push(p);
  return parts.slice(0, 8).map(p => p || 0);
}

function normalizeMappedIPv4(ip: string): string {
  // handle IPv4-mapped IPv6 (::ffff:1.2.3.4)
  if (ip.startsWith('::ffff:')) {
    const parts = ip.split(':');
    const last = parts[parts.length - 1];
    if (net.isIP(last) === 4) return last;
  }
  return ip;
}
