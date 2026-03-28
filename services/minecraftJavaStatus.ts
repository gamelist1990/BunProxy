function readVarInt(buffer: Buffer, offset: number): { value: number; nextOffset: number } | null {
  let result = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length && shift < 35) {
    const byte = buffer[cursor++];
    result |= (byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value: result, nextOffset: cursor };
    }

    shift += 7;
  }

  return null;
}

export function isMinecraftJavaStatusPing(payload: Buffer | null | undefined): boolean {
  if (!payload || payload.length === 0) {
    return false;
  }

  if (payload[0] === 0xfe) {
    return true;
  }

  const packetLength = readVarInt(payload, 0);
  if (!packetLength || packetLength.value <= 0) {
    return false;
  }

  if (packetLength.nextOffset + packetLength.value > payload.length) {
    return false;
  }

  let cursor = packetLength.nextOffset;
  const packetId = readVarInt(payload, cursor);
  if (!packetId || packetId.value !== 0x00) {
    return false;
  }
  cursor = packetId.nextOffset;

  const protocolVersion = readVarInt(payload, cursor);
  if (!protocolVersion) {
    return false;
  }
  cursor = protocolVersion.nextOffset;

  const hostLength = readVarInt(payload, cursor);
  if (!hostLength || hostLength.value < 0) {
    return false;
  }
  cursor = hostLength.nextOffset + hostLength.value;

  if (cursor + 2 > payload.length) {
    return false;
  }

  cursor += 2;

  const nextState = readVarInt(payload, cursor);
  if (!nextState) {
    return false;
  }

  return nextState.value === 0x01;
}
