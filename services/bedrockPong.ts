const RAKNET_OFFLINE_MESSAGE_ID = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

const UNCONNECTED_PONG_ID = 0x1c;
const UNCONNECTED_PONG_STRING_OFFSET = 35;

export function rewriteBedrockUnconnectedPongPorts(
  payload: Buffer,
  listenerPort: number
): { payload: Buffer; rewritten: boolean; originalPorts?: { ipv4?: number; ipv6?: number } } {
  if (payload.length < UNCONNECTED_PONG_STRING_OFFSET) {
    return { payload, rewritten: false };
  }

  if (payload[0] !== UNCONNECTED_PONG_ID) {
    return { payload, rewritten: false };
  }

  if (!payload.subarray(17, 33).equals(RAKNET_OFFLINE_MESSAGE_ID)) {
    return { payload, rewritten: false };
  }

  const stringLength = payload.readUInt16BE(33);
  const stringEnd = UNCONNECTED_PONG_STRING_OFFSET + stringLength;
  if (payload.length < stringEnd) {
    return { payload, rewritten: false };
  }

  const motd = payload.subarray(UNCONNECTED_PONG_STRING_OFFSET, stringEnd).toString('utf8');
  const parts = motd.split(';');
  if (parts.length < 12) {
    return { payload, rewritten: false };
  }

  const originalIpv4 = Number(parts[10]);
  const originalIpv6 = Number(parts[11]);
  const nextParts = [...parts];
  nextParts[10] = String(listenerPort);
  nextParts[11] = String(listenerPort);

  const rewrittenMotd = nextParts.join(';');
  if (rewrittenMotd === motd) {
    return {
      payload,
      rewritten: false,
      originalPorts: {
        ipv4: Number.isFinite(originalIpv4) ? originalIpv4 : undefined,
        ipv6: Number.isFinite(originalIpv6) ? originalIpv6 : undefined,
      },
    };
  }

  const motdBuffer = Buffer.from(rewrittenMotd, 'utf8');
  const rewritten = Buffer.concat([
    payload.subarray(0, 33),
    Buffer.alloc(2),
    motdBuffer,
    payload.subarray(stringEnd),
  ]);
  rewritten.writeUInt16BE(motdBuffer.length, 33);

  return {
    payload: rewritten,
    rewritten: true,
    originalPorts: {
      ipv4: Number.isFinite(originalIpv4) ? originalIpv4 : undefined,
      ipv6: Number.isFinite(originalIpv6) ? originalIpv6 : undefined,
    },
  };
}
