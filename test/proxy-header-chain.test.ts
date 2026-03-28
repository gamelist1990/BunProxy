import { describe, expect, test } from 'bun:test';
import { generateProxyProtocolV2Header } from '../services/proxyProtocolBuilder.js';
import { buildUdpForwardPayload } from '../services/udpProxyForwarding.js';
import { getOriginalClientFromHeaders, parseProxyV2Chain } from '../services/proxyProtocolParser.js';

describe('TCP PROXY protocol forwarding', () => {
  test('strips incoming PROXY header chain before relaying payload', () => {
    const payload = Buffer.from('hello-through-proxy', 'utf8');
    const incomingHeader = generateProxyProtocolV2Header(
      '178.128.192.22',
      36256,
      '132.145.123.39',
      5000,
      false
    );
    const inboundChunk = Buffer.concat([incomingHeader, payload]);

    const chain = parseProxyV2Chain(inboundChunk);

    expect(chain.headers).toHaveLength(1);
    expect(chain.payload.equals(payload)).toBe(true);
    expect(getOriginalClientFromHeaders(chain.headers)).toEqual({
      ip: '178.128.192.22',
      port: 36256,
    });
  });

  test('new outgoing header plus stripped payload results in a single header on the wire', () => {
    const payload = Buffer.from('bedrock-handshake', 'utf8');
    const incomingHeader = generateProxyProtocolV2Header(
      '49.105.101.8',
      63105,
      '132.145.123.39',
      5000,
      false
    );

    const inboundChunk = Buffer.concat([incomingHeader, payload]);
    const parsed = parseProxyV2Chain(inboundChunk);
    const original = getOriginalClientFromHeaders(parsed.headers);

    expect(original).not.toBeNull();

    const forwardedHeader = generateProxyProtocolV2Header(
      original!.ip,
      original!.port,
      '132.145.123.39',
      5000,
      false
    );
    const forwardedChunk = Buffer.concat([forwardedHeader, parsed.payload]);
    const reparsed = parseProxyV2Chain(forwardedChunk);

    expect(reparsed.headers).toHaveLength(1);
    expect(reparsed.payload.equals(payload)).toBe(true);
  });

  test('UDP helper prepends a single PROXY header to a datagram payload', () => {
    const payload = Buffer.from('query-one', 'utf8');

    const datagram = buildUdpForwardPayload(
      payload,
      '175.130.34.175',
      55280,
      '132.145.123.39',
      5000
    );

    const parsed = parseProxyV2Chain(datagram);

    expect(parsed.headers).toHaveLength(1);
    expect(parsed.payload.equals(payload)).toBe(true);
  });
});
