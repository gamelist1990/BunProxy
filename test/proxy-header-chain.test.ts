import { describe, expect, test } from 'bun:test';
import {
  inspectBedrockUnconnectedPong,
  normalizeBedrockUnconnectedPong,
  rewriteBedrockUnconnectedPongPorts,
} from '../services/bedrockPong.js';
import { generateProxyProtocolV2Header } from '../services/proxyProtocolBuilder.js';
import {
  describeRakNetPacket,
  getRakNetPacketKind,
  getRakNetSessionPacketKind,
  getRakNetSessionStage,
  isRakNetSessionStartPacket,
} from '../services/raknetPacket.js';
import { buildUdpForwardPayload } from '../services/udpProxyForwarding.js';
import { getOriginalClientFromHeaders, getOriginalDestinationFromHeaders, parseProxyV2Chain } from '../services/proxyProtocolParser.js';

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

  test('preserves original destination in parsed PROXY headers', () => {
    const payload = Buffer.from('status-request', 'utf8');
    const header = generateProxyProtocolV2Header(
      '49.105.101.8',
      49397,
      '203.0.113.25',
      25565,
      false
    );
    const parsed = parseProxyV2Chain(Buffer.concat([header, payload]));

    expect(getOriginalClientFromHeaders(parsed.headers)).toEqual({
      ip: '49.105.101.8',
      port: 49397,
    });
    expect(getOriginalDestinationFromHeaders(parsed.headers)).toEqual({
      ip: '203.0.113.25',
      port: 25565,
    });
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

  test('detects RakNet offline ping and open connection packets as UDP session starts', () => {
    const magic = Buffer.from([
      0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
      0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
    ]);

    const unconnectedPing = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.alloc(8, 0x11),
      magic,
      Buffer.alloc(8, 0x22),
    ]);
    const openConnectionRequest1 = Buffer.concat([
      Buffer.from([0x05]),
      magic,
      Buffer.from([0x0b]),
      Buffer.alloc(10, 0x00),
    ]);
    const regularConnectedPacket = Buffer.concat([
      Buffer.from([0x84]),
      Buffer.alloc(10, 0x00),
    ]);

    expect(isRakNetSessionStartPacket(unconnectedPing)).toBe(true);
    expect(isRakNetSessionStartPacket(openConnectionRequest1)).toBe(true);
    expect(isRakNetSessionStartPacket(regularConnectedPacket)).toBe(false);
    expect(getRakNetSessionPacketKind(unconnectedPing)).toBe('offline_ping');
    expect(getRakNetSessionPacketKind(openConnectionRequest1)).toBe('open_connection');
    expect(getRakNetSessionPacketKind(regularConnectedPacket)).toBe('other');
  });

  test('classifies RakNet packets into readable kinds and stages', () => {
    const magic = Buffer.from([
      0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
      0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
    ]);

    const offlinePing = Buffer.concat([
      Buffer.from([0x01]),
      Buffer.alloc(8, 0x11),
      magic,
      Buffer.alloc(8, 0x22),
    ]);
    const openConnectionReply1 = Buffer.concat([
      Buffer.from([0x06]),
      magic,
      Buffer.alloc(11, 0x00),
    ]);
    const disconnectNotification = Buffer.from([0x15]);
    const frameSet = Buffer.concat([
      Buffer.from([0x84]),
      Buffer.alloc(10, 0x00),
    ]);

    expect(getRakNetPacketKind(offlinePing)).toBe('offline_ping');
    expect(getRakNetSessionStage(getRakNetPacketKind(offlinePing))).toBe('discovery');
    expect(describeRakNetPacket(offlinePing)).toContain('Unconnected Ping');

    expect(getRakNetPacketKind(openConnectionReply1)).toBe('open_connection_reply_1');
    expect(getRakNetSessionStage(getRakNetPacketKind(openConnectionReply1))).toBe('opening');

    expect(getRakNetPacketKind(disconnectNotification)).toBe('disconnect_notification');
    expect(getRakNetSessionStage(getRakNetPacketKind(disconnectNotification))).toBe('disconnecting');

    expect(getRakNetPacketKind(frameSet)).toBe('frame_set');
    expect(getRakNetSessionStage(getRakNetPacketKind(frameSet))).toBe('connected');
  });

  test('rewrites Bedrock unconnected pong advertised ports to the listener port', () => {
    const motd = 'MCPE;§r§9Dedicated Server;776;1.21.80;1;20;13253860892328930865;§r§aProxy Test;Survival;1;5000;5001;';
    const motdBuffer = Buffer.from(motd, 'utf8');
    const pong = Buffer.concat([
      Buffer.from([0x1c]),
      Buffer.alloc(8, 0x11),
      Buffer.alloc(8, 0x22),
      Buffer.from([
        0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
        0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
      ]),
      Buffer.from([motdBuffer.length >> 8, motdBuffer.length & 0xff]),
      motdBuffer,
    ]);

    const rewritten = rewriteBedrockUnconnectedPongPorts(pong, 25565);
    const rewrittenLength = rewritten.payload.readUInt16BE(33);
    const rewrittenMotd = rewritten.payload.subarray(35, 35 + rewrittenLength).toString('utf8');

    expect(rewritten.rewritten).toBe(true);
    expect(rewritten.originalPorts).toEqual({ ipv4: 5000, ipv6: 5001 });
    expect(rewrittenMotd.startsWith('MCPE;§r§9Dedicated Server;776;1.21.80;1;20;13253860892328930865;§r§aProxy Test;Survival;1;')).toBe(true);
    expect(rewrittenMotd.includes(';25565;25565;')).toBe(true);
  });

  test('inspects Bedrock unconnected pong fields without modifying the payload', () => {
    const motd = 'MCPE;PEXserver;944;26.10;0;2025;1757476976326314584;Join now;Survival;1;5000;5000;';
    const payload = Buffer.concat([
      Buffer.from([0x1c]),
      Buffer.alloc(8, 0x11),
      Buffer.alloc(8, 0x22),
      Buffer.from([
        0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
        0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
      ]),
      Buffer.from([motd.length >> 8, motd.length & 0xff]),
      Buffer.from(motd, 'utf8'),
    ]);

    const inspected = inspectBedrockUnconnectedPong(payload);

    expect(inspected).not.toBeNull();
    expect(inspected?.motd).toBe(motd);
    expect(inspected?.advertisedPortV4).toBe(5000);
    expect(inspected?.advertisedPortV6).toBe(5000);
  });

  test('normalizes Bedrock unconnected pong MOTD text for client compatibility', () => {
    const motd = 'MCPE;\u00a7r\u00a79Fancy Server v1.21.11;944;26.10;0;2025;123456789;\u00a7fJoin now \u2014 \u00a7a0/2025;Survival;1;5000;5000;';
    const pong = Buffer.concat([
      Buffer.from([0x1c]),
      Buffer.alloc(8, 0x11),
      Buffer.alloc(8, 0x22),
      Buffer.from([
        0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
        0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
      ]),
      Buffer.from([0x00, Buffer.byteLength(motd)]),
      Buffer.from(motd, 'utf8'),
    ]);

    const normalized = normalizeBedrockUnconnectedPong(pong, 25565);
    const normalizedLength = normalized.payload.readUInt16BE(33);
    const normalizedMotd = normalized.payload.subarray(35, 35 + normalizedLength).toString('utf8');

    expect(normalized.rewritten).toBe(true);
    expect(normalizedMotd.includes('Fancy Server v1.21.11')).toBe(true);
    expect(normalizedMotd.includes(';26.10;')).toBe(true);
    expect(normalizedMotd.includes('Join now - 0/2025')).toBe(true);
    expect(normalizedMotd.includes(';25565;25565;')).toBe(true);
  });
});
