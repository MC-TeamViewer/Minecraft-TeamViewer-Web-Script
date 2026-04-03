import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { AdminInboundPacket, AdminOutboundPacket } from './networkSchemas';
import { parseAdminInboundPacket } from './networkSchemas';
import {
  AdminAckSchema,
  CommandPlayerMarkClearAllSchema,
  CommandPlayerMarkClearSchema,
  CommandPlayerMarkSetSchema,
  CommandSameServerFilterSetSchema,
  CommandTacticalWaypointSetSchema,
  HandshakeAckSchema,
  HandshakeRequestSchema,
  PatchSchema,
  PongSchema,
  ResyncRequestSchema,
  SnapshotFullSchema,
  WaypointsDeleteSchema,
  WireChannel,
  WireEnvelopeSchema,
} from './proto/teamviewer/v1/teamviewer_pb';

function toScopePatch(scope: { upsert: Array<{ id: string; data?: Record<string, unknown> }>; delete: string[] } | undefined) {
  if (!scope) {
    return undefined;
  }
  const upsert: Record<string, unknown> = {};
  for (const item of scope.upsert || []) {
    if (!item || typeof item.id !== 'string' || !item.id) {
      continue;
    }
    upsert[item.id] = item.data && typeof item.data === 'object' ? item.data : {};
  }
  const deleteIds = Array.isArray(scope.delete) ? scope.delete.filter((item) => typeof item === 'string' && item) : [];
  if (!Object.keys(upsert).length && !deleteIds.length) {
    return undefined;
  }
  return { upsert, delete: deleteIds };
}

function decodeAdminAck(message: any): AdminInboundPacket | null {
  const payload: Record<string, unknown> = {
    type: 'admin_ack',
    ok: Boolean(message.ok),
  };
  if (message.action !== undefined) payload.action = message.action;
  if (message.error !== undefined) payload.error = message.error;
  if (message.command !== undefined) payload.command = message.command;

  const detail = message.detail;
  if (detail?.case === 'playerMark') {
    if (detail.value?.playerId !== undefined) payload.playerId = detail.value.playerId;
    if (detail.value?.mark !== undefined) payload.mark = detail.value.mark;
  } else if (detail?.case === 'clearAllPlayerMarks') {
    payload.removedCount = detail.value?.removedCount ?? 0;
  } else if (detail?.case === 'sameServerFilter') {
    payload.enabled = Boolean(detail.value?.enabled);
  } else if (detail?.case === 'tacticalWaypoint') {
    if (detail.value?.waypointId !== undefined) payload.waypointId = detail.value.waypointId;
    if (detail.value?.waypoint !== undefined) payload.waypoint = detail.value.waypoint;
  } else if (detail?.case === 'waypointsDelete') {
    payload.waypointIds = Array.isArray(detail.value?.waypointIds) ? detail.value.waypointIds : [];
  }

  return parseAdminInboundPacket(payload);
}

function decodeSnapshotFull(message: any): AdminInboundPacket | null {
  return parseAdminInboundPacket({
    type: 'snapshot_full',
    players: message.players ?? {},
    entities: message.entities ?? {},
    waypoints: message.waypoints ?? {},
    battleChunks: message.battleChunks ?? {},
    playerMarks: message.playerMarks ?? {},
    tabState: message.tabState ?? undefined,
    roomCode: message.roomCode ?? undefined,
    connections: Array.isArray(message.connections) ? message.connections : [],
    connections_count: message.connectionsCount ?? undefined,
    server_time: message.serverTime ?? undefined,
  });
}

function decodePatch(message: any): AdminInboundPacket | null {
  const meta: Record<string, unknown> = {};

  if (message.tabStatePatch) {
    meta.tabStatePatch = {
      ...message.tabStatePatch,
      groups: message.tabStatePatch.groups?.values ?? undefined,
    };
  }

  if (message.connections) {
    meta.connections = message.connections.values ?? [];
  }

  if (message.connectionsCount !== undefined) {
    meta.connections_count = message.connectionsCount;
  }

  return parseAdminInboundPacket({
    type: 'patch',
    players: toScopePatch(message.players),
    entities: toScopePatch(message.entities),
    waypoints: toScopePatch(message.waypoints),
    battleChunks: toScopePatch(message.battleChunks),
    playerMarks: toScopePatch(message.playerMarks),
    meta: Object.keys(meta).length ? meta : undefined,
    server_time: message.serverTime ?? undefined,
  });
}

export interface NetworkMessageCodec {
  encode(packet: AdminOutboundPacket): ArrayBuffer;
  decode(payload: ArrayBuffer | Uint8Array | string): AdminInboundPacket | null;
}

export class ProtobufNetworkMessageCodec implements NetworkMessageCodec {
  encode(packet: AdminOutboundPacket): ArrayBuffer {
    switch (packet.type) {
      case 'handshake': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'handshakeRequest',
            value: create(HandshakeRequestSchema, {
              networkProtocolVersion: packet.networkProtocolVersion,
              minimumCompatibleNetworkProtocolVersion: packet.minimumCompatibleNetworkProtocolVersion,
              localProgramVersion: packet.localProgramVersion,
              roomCode: packet.roomCode,
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'resync_req': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'resyncRequest',
            value: create(ResyncRequestSchema, {
              reason: packet.reason,
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'command_player_mark_set': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'commandPlayerMarkSet',
            value: create(CommandPlayerMarkSetSchema, {
              playerId: packet.playerId,
              team: packet.team,
              color: packet.color,
              label: packet.label,
              source: packet.source,
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'command_player_mark_clear': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'commandPlayerMarkClear',
            value: create(CommandPlayerMarkClearSchema, {
              playerId: packet.playerId,
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'command_player_mark_clear_all': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'commandPlayerMarkClearAll',
            value: create(CommandPlayerMarkClearAllSchema, {}),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'command_same_server_filter_set': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'commandSameServerFilterSet',
            value: create(CommandSameServerFilterSetSchema, {
              enabled: Boolean(packet.enabled),
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'command_tactical_waypoint_set': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'commandTacticalWaypointSet',
            value: create(CommandTacticalWaypointSetSchema, {
              x: packet.x,
              z: packet.z,
              label: packet.label,
              dimension: packet.dimension,
              tacticalType: packet.tacticalType,
              permanent: packet.permanent,
              ttlSeconds: packet.ttlSeconds,
              color: packet.color,
              roomCode: packet.roomCode,
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      case 'waypoints_delete': {
        const envelope = create(WireEnvelopeSchema, {
          channel: WireChannel.ADMIN,
          payload: {
            case: 'waypointsDelete',
            value: create(WaypointsDeleteSchema, {
              waypointIds: packet.waypointIds,
            }),
          },
        });
        return toBinary(WireEnvelopeSchema, envelope).buffer as ArrayBuffer;
      }
      default:
        throw new Error(`Unsupported admin outbound packet: ${(packet as { type?: string }).type || 'unknown'}`);
    }
  }

  decode(payload: ArrayBuffer | Uint8Array | string): AdminInboundPacket | null {
    if (typeof payload === 'string') {
      return null;
    }

    const raw = payload instanceof Uint8Array ? payload : new Uint8Array(payload);

    let envelope;
    try {
      envelope = fromBinary(WireEnvelopeSchema, raw);
    } catch {
      return null;
    }

    switch (envelope.payload.case) {
      case 'adminAck':
        return decodeAdminAck(envelope.payload.value);
      case 'handshakeAck':
        return parseAdminInboundPacket({
          type: 'handshake_ack',
          ready: envelope.payload.value.ready,
          networkProtocolVersion: envelope.payload.value.networkProtocolVersion,
          minimumCompatibleNetworkProtocolVersion: envelope.payload.value.minimumCompatibleNetworkProtocolVersion,
          localProgramVersion: envelope.payload.value.localProgramVersion,
          roomCode: envelope.payload.value.roomCode,
          error: envelope.payload.value.error,
          rejectReason: envelope.payload.value.rejectReason,
          digestIntervalSec: envelope.payload.value.digestIntervalSec,
          broadcastHz: envelope.payload.value.broadcastHz,
          reportIntervalTicks: envelope.payload.value.reportIntervalTicks,
          playerTimeoutSec: envelope.payload.value.playerTimeoutSec,
          entityTimeoutSec: envelope.payload.value.entityTimeoutSec,
          battleChunkTimeoutSec: envelope.payload.value.battleChunkTimeoutSec,
        });
      case 'pong':
        return parseAdminInboundPacket({
          type: 'pong',
          serverTime: envelope.payload.value.serverTime,
        });
      case 'snapshotFull':
        return decodeSnapshotFull(envelope.payload.value);
      case 'patch':
        return decodePatch(envelope.payload.value);
      default:
        return null;
    }
  }
}
