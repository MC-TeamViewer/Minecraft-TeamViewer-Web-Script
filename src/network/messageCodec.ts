import { fromBinary, toBinary } from '@bufbuild/protobuf';
import type { WebMapInboundPacket } from './networkSchemas';
import {
  WireEnvelopeSchema,
  type WireEnvelope,
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

function buildBattleChunkSyntheticId(dimension: unknown, chunkX: unknown, chunkZ: unknown) {
  const dim = String(dimension || '').trim();
  const x = Number(chunkX);
  const z = Number(chunkZ);
  if (!dim || !Number.isFinite(x) || !Number.isFinite(z)) {
    return null;
  }
  return `${dim}|${Math.trunc(x)}|${Math.trunc(z)}`;
}

function toBattleChunkLocalData(ref: any, value: any) {
  const dimension = String(ref?.dimension || '').trim();
  const chunkX = Number(ref?.coord?.chunkX);
  const chunkZ = Number(ref?.coord?.chunkZ);
  const syntheticId = buildBattleChunkSyntheticId(dimension, chunkX, chunkZ);
  if (!syntheticId) {
    return null;
  }
  return {
    id: syntheticId,
    data: {
      ...(value && typeof value === 'object' ? value : {}),
      dimension,
      chunkX: Math.trunc(chunkX),
      chunkZ: Math.trunc(chunkZ),
    },
  };
}

function decodeBattleChunkSnapshot(entries: any) {
  const mapped: Record<string, unknown> = {};
  if (!Array.isArray(entries)) {
    return mapped;
  }
  for (const entry of entries) {
    const local = toBattleChunkLocalData(entry?.ref, entry?.data);
    if (!local) {
      continue;
    }
    mapped[local.id] = local.data;
  }
  return mapped;
}

function decodeBattleChunkPatch(scope: any) {
  if (!scope || typeof scope !== 'object') {
    return undefined;
  }
  const upsert: Record<string, unknown> = {};
  for (const entry of Array.isArray(scope.upsert) ? scope.upsert : []) {
    const local = toBattleChunkLocalData(entry?.ref, entry?.data);
    if (!local) {
      continue;
    }
    upsert[local.id] = local.data;
  }

  const deleteIds = (Array.isArray(scope.delete) ? scope.delete : [])
    .map((item) => toBattleChunkLocalData(item, {}))
    .filter((item): item is { id: string; data: Record<string, unknown> } => Boolean(item))
    .map((item) => item.id);

  if (!Object.keys(upsert).length && !deleteIds.length) {
    return undefined;
  }
  return { upsert, delete: deleteIds };
}

function decodeWebMapAck(message: any): WebMapInboundPacket | null {
  const payload: Record<string, unknown> = {
    type: 'web_map_ack',
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

  return payload as WebMapInboundPacket;
}

function decodeSnapshotFull(message: any): WebMapInboundPacket | null {
  return {
    type: 'snapshot_full',
    players: message.players ?? {},
    entities: message.entities ?? {},
    waypoints: message.waypoints ?? {},
    battleChunks: decodeBattleChunkSnapshot(message.battleChunks),
    playerMarks: message.playerMarks ?? {},
    tabState: message.tabState ?? undefined,
    roomCode: message.roomCode ?? undefined,
    connections: Array.isArray(message.connections) ? message.connections : [],
    connections_count: message.connectionsCount ?? undefined,
    server_time: message.serverTime ?? undefined,
  };
}

function decodePatch(message: any): WebMapInboundPacket | null {
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

  return {
    type: 'patch',
    players: toScopePatch(message.players),
    entities: toScopePatch(message.entities),
    waypoints: toScopePatch(message.waypoints),
    battleChunks: decodeBattleChunkPatch(message.battleChunks),
    playerMarks: toScopePatch(message.playerMarks),
    meta: Object.keys(meta).length ? meta : undefined,
    server_time: message.serverTime ?? undefined,
  };
}

function decodeBattleChunkMetaSnapshot(message: any): WebMapInboundPacket | null {
  return {
    type: 'battle_chunk_meta_snapshot',
    battleChunks: decodeBattleChunkSnapshot(message.battleChunks),
  };
}

export interface NetworkMessageCodec {
  encode(packet: WireEnvelope): ArrayBuffer;
  decode(payload: ArrayBuffer | Uint8Array | string): WebMapInboundPacket | null;
}

export class ProtobufNetworkMessageCodec implements NetworkMessageCodec {
  encode(packet: WireEnvelope): ArrayBuffer {
    return toBinary(WireEnvelopeSchema, packet).buffer as ArrayBuffer;
  }

  decode(payload: ArrayBuffer | Uint8Array | string): WebMapInboundPacket | null {
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
      case 'webMapAck':
        return decodeWebMapAck(envelope.payload.value);
      case 'handshakeAck':
        return {
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
        } as WebMapInboundPacket;
      case 'pong':
        return {
          type: 'pong',
          serverTime: envelope.payload.value.serverTime,
        } as WebMapInboundPacket;
      case 'snapshotFull':
        return decodeSnapshotFull(envelope.payload.value);
      case 'patch':
        return decodePatch(envelope.payload.value);
      case 'battleChunkMetaSnapshot':
        return decodeBattleChunkMetaSnapshot(envelope.payload.value);
      default:
        return null;
    }
  }
}
