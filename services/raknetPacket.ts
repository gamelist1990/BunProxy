const RAKNET_OFFLINE_MESSAGE_ID = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);

export type RakNetPacketKind =
  | 'connected_ping'
  | 'offline_ping'
  | 'offline_ping_open_connections'
  | 'open_connection_request_1'
  | 'open_connection_reply_1'
  | 'open_connection_request_2'
  | 'open_connection_reply_2'
  | 'connection_request'
  | 'connection_request_accepted'
  | 'connection_attempt_failed'
  | 'new_incoming_connection'
  | 'disconnect_notification'
  | 'incompatible_protocol'
  | 'unconnected_pong'
  | 'ack'
  | 'nack'
  | 'frame_set'
  | 'other';

export type RakNetSessionPacketKind = 'offline_ping' | 'open_connection' | 'other';
export type RakNetSessionStage = 'discovery' | 'opening' | 'connected' | 'disconnecting' | 'other';

function hasRakNetMagicAt(payload: Buffer, offset: number): boolean {
  const end = offset + RAKNET_OFFLINE_MESSAGE_ID.length;
  if (payload.length < end) {
    return false;
  }

  return payload.subarray(offset, end).equals(RAKNET_OFFLINE_MESSAGE_ID);
}

export function isRakNetSessionStartPacket(payload: Buffer): boolean {
  return getRakNetSessionPacketKind(payload) !== 'other';
}

export function getRakNetPacketKind(payload: Buffer): RakNetPacketKind {
  if (payload.length === 0) {
    return 'other';
  }

  const packetId = payload[0];

  switch (packetId) {
    case 0x00:
      return payload.length === 9 ? 'connected_ping' : 'other';
    case 0x01:
      return hasRakNetMagicAt(payload, 9) ? 'offline_ping' : 'other';
    case 0x02:
      return hasRakNetMagicAt(payload, 9) ? 'offline_ping_open_connections' : 'other';
    case 0x05:
      return hasRakNetMagicAt(payload, 1) ? 'open_connection_request_1' : 'other';
    case 0x06:
      return hasRakNetMagicAt(payload, 1) ? 'open_connection_reply_1' : 'other';
    case 0x07:
      return hasRakNetMagicAt(payload, 1) ? 'open_connection_request_2' : 'other';
    case 0x08:
      return hasRakNetMagicAt(payload, 1) ? 'open_connection_reply_2' : 'other';
    case 0x09:
      return 'connection_request';
    case 0x10:
      return 'connection_request_accepted';
    case 0x11:
      return 'connection_attempt_failed';
    case 0x13:
      return 'new_incoming_connection';
    case 0x15:
      return 'disconnect_notification';
    case 0x19:
      return 'incompatible_protocol';
    case 0x1c:
      return hasRakNetMagicAt(payload, 17) ? 'unconnected_pong' : 'other';
    case 0xa0:
      return 'nack';
    case 0xc0:
      return 'ack';
    default:
      if (packetId >= 0x80 && packetId <= 0x8d) {
        return 'frame_set';
      }
      return 'other';
  }
}

export function getRakNetSessionPacketKind(payload: Buffer): RakNetSessionPacketKind {
  const kind = getRakNetPacketKind(payload);
  if (kind === 'offline_ping' || kind === 'offline_ping_open_connections') {
    return 'offline_ping';
  }
  if (kind === 'open_connection_request_1' || kind === 'open_connection_request_2') {
    return 'open_connection';
  }
  return 'other';
}

export function getRakNetSessionStage(kind: RakNetPacketKind): RakNetSessionStage {
  switch (kind) {
    case 'offline_ping':
    case 'offline_ping_open_connections':
    case 'unconnected_pong':
      return 'discovery';
    case 'open_connection_request_1':
    case 'open_connection_reply_1':
    case 'open_connection_request_2':
    case 'open_connection_reply_2':
      return 'opening';
    case 'connection_request':
    case 'connection_request_accepted':
    case 'new_incoming_connection':
    case 'connected_ping':
    case 'ack':
    case 'nack':
    case 'frame_set':
      return 'connected';
    case 'disconnect_notification':
    case 'connection_attempt_failed':
    case 'incompatible_protocol':
      return 'disconnecting';
    default:
      return 'other';
  }
}

export function describeRakNetPacket(payload: Buffer): string {
  const kind = getRakNetPacketKind(payload);
  const packetId = payload.length > 0 ? payload[0] : -1;
  const idText = packetId >= 0 ? `0x${packetId.toString(16).padStart(2, '0')}` : 'n/a';

  switch (kind) {
    case 'connected_ping':
      return `RakNet Connected Ping (${idText})`;
    case 'offline_ping':
      return `RakNet Unconnected Ping (${idText})`;
    case 'offline_ping_open_connections':
      return `RakNet Unconnected Ping Open Connections (${idText})`;
    case 'open_connection_request_1':
      return `RakNet Open Connection Request 1 (${idText})`;
    case 'open_connection_reply_1':
      return `RakNet Open Connection Reply 1 (${idText})`;
    case 'open_connection_request_2':
      return `RakNet Open Connection Request 2 (${idText})`;
    case 'open_connection_reply_2':
      return `RakNet Open Connection Reply 2 (${idText})`;
    case 'connection_request':
      return `RakNet Connection Request (${idText})`;
    case 'connection_request_accepted':
      return `RakNet Connection Request Accepted (${idText})`;
    case 'connection_attempt_failed':
      return `RakNet Connection Attempt Failed (${idText})`;
    case 'new_incoming_connection':
      return `RakNet New Incoming Connection (${idText})`;
    case 'disconnect_notification':
      return `RakNet Disconnect Notification (${idText})`;
    case 'incompatible_protocol':
      return `RakNet Incompatible Protocol (${idText})`;
    case 'unconnected_pong':
      return `RakNet Unconnected Pong (${idText})`;
    case 'ack':
      return `RakNet ACK (${idText})`;
    case 'nack':
      return `RakNet NACK (${idText})`;
    case 'frame_set':
      return `RakNet Frame Set (${idText})`;
    default:
      return `RakNet Unknown (${idText})`;
  }
}
