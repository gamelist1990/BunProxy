const RAKNET_OFFLINE_MESSAGE_ID = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

function hasRakNetMagicAt(payload: Buffer, offset: number): boolean {
  const end = offset + RAKNET_OFFLINE_MESSAGE_ID.length;
  if (payload.length < end) {
    return false;
  }

  return payload.subarray(offset, end).equals(RAKNET_OFFLINE_MESSAGE_ID);
}

export function isRakNetSessionStartPacket(payload: Buffer): boolean {
  if (payload.length === 0) {
    return false;
  }

  const packetId = payload[0];

  // Unconnected Ping / Unconnected Ping Open Connections
  if ((packetId === 0x01 || packetId === 0x02) && hasRakNetMagicAt(payload, 9)) {
    return true;
  }

  // Open Connection Request 1 / 2
  if ((packetId === 0x05 || packetId === 0x07) && hasRakNetMagicAt(payload, 1)) {
    return true;
  }

  return false;
}
