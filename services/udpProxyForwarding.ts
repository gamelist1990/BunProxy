import { generateProxyProtocolV2Header } from './proxyProtocolBuilder.js';

export function buildUdpForwardPayload(
  payload: Buffer,
  sourceIP: string,
  sourcePort: number,
  destIP: string,
  destPort: number
): Buffer {
  const header = generateProxyProtocolV2Header(
    sourceIP,
    sourcePort,
    destIP,
    destPort,
    true
  );

  return Buffer.concat([header, payload]);
}
