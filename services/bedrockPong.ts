const RAKNET_OFFLINE_MESSAGE_ID = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

const UNCONNECTED_PONG_ID = 0x1c;
const UNCONNECTED_PONG_STRING_OFFSET = 35;

type ParsedBedrockPong = {
  motd: string;
  parts: string[];
  stringEnd: number;
};

function parseBedrockUnconnectedPong(payload: Buffer): ParsedBedrockPong | null {
  if (payload.length < UNCONNECTED_PONG_STRING_OFFSET) {
    return null;
  }

  if (payload[0] !== UNCONNECTED_PONG_ID) {
    return null;
  }

  if (!payload.subarray(17, 33).equals(RAKNET_OFFLINE_MESSAGE_ID)) {
    return null;
  }

  const stringLength = payload.readUInt16BE(33);
  const stringEnd = UNCONNECTED_PONG_STRING_OFFSET + stringLength;
  if (payload.length < stringEnd) {
    return null;
  }

  const motd = payload.subarray(UNCONNECTED_PONG_STRING_OFFSET, stringEnd).toString('utf8');
  const parts = motd.split(';');
  if (parts.length < 12) {
    return null;
  }

  return { motd, parts, stringEnd };
}

export function inspectBedrockUnconnectedPong(
  payload: Buffer,
): {
  motd: string;
  advertisedPortV4?: number;
  advertisedPortV6?: number;
} | null {
  const parsed = parseBedrockUnconnectedPong(payload);
  if (!parsed) {
    return null;
  }

  const advertisedPortV4 = Number(parsed.parts[10]);
  const advertisedPortV6 = Number(parsed.parts[11]);

  return {
    motd: parsed.motd,
    advertisedPortV4: Number.isFinite(advertisedPortV4) ? advertisedPortV4 : undefined,
    advertisedPortV6: Number.isFinite(advertisedPortV6) ? advertisedPortV6 : undefined,
  };
}

function normalizeMotdText(text: string, maxLength: number) {
  const withoutFormatting = text.replace(/\u00a7./g, '');
  const withAsciiDash = withoutFormatting.replace(/\u2014/g, '-');
  const withoutSymbols = withAsciiDash.replace(/[^\x20-\x7e]/g, '');
  const collapsed = withoutSymbols.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }

  return collapsed.slice(0, maxLength).trim();
}

export function normalizeBedrockUnconnectedPong(
  payload: Buffer,
  listenerPort: number
): {
  payload: Buffer;
  rewritten: boolean;
  originalPorts?: { ipv4?: number; ipv6?: number };
  originalMotd?: string;
  normalizedMotd?: string;
} {
  const parsed = parseBedrockUnconnectedPong(payload);
  if (!parsed) {
    return { payload, rewritten: false };
  }

  const { motd, parts, stringEnd } = parsed;
  const originalIpv4 = Number(parts[10]);
  const originalIpv6 = Number(parts[11]);
  const nextParts = [...parts];
  nextParts[1] = normalizeMotdText(parts[1], 64) || 'Bedrock Server';
  nextParts[3] = parts[3];
  nextParts[7] = normalizeMotdText(parts[7], 64);
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
      originalMotd: motd,
      normalizedMotd: motd,
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
    originalMotd: motd,
    normalizedMotd: rewrittenMotd,
  };
}

export function rewriteBedrockUnconnectedPongPorts(
  payload: Buffer,
  listenerPort: number
): { payload: Buffer; rewritten: boolean; originalPorts?: { ipv4?: number; ipv6?: number } } {
  const parsed = parseBedrockUnconnectedPong(payload);
  if (!parsed) {
    return { payload, rewritten: false };
  }

  const { motd, parts, stringEnd } = parsed;
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
  const rewrittenPayload = Buffer.concat([
    payload.subarray(0, 33),
    Buffer.alloc(2),
    motdBuffer,
    payload.subarray(stringEnd),
  ]);
  rewrittenPayload.writeUInt16BE(motdBuffer.length, 33);

  return {
    payload: rewrittenPayload,
    rewritten: true,
    originalPorts: {
      ipv4: Number.isFinite(originalIpv4) ? originalIpv4 : undefined,
      ipv6: Number.isFinite(originalIpv6) ? originalIpv6 : undefined,
    },
  };
}
