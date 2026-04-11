import { create } from '@bufbuild/protobuf';
import {
  ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION,
  ADMIN_NETWORK_PROTOCOL_VERSION,
  LOCAL_PROGRAM_VERSION,
} from '../constants';
import { normalizeDimension, normalizeRoomCode } from '../utils/overlayUtils';
import {
  BattleChunkMetaRequestSchema,
  CommandPlayerMarkClearAllSchema,
  CommandPlayerMarkClearSchema,
  CommandPlayerMarkSetSchema,
  CommandSameServerFilterSetSchema,
  CommandTacticalWaypointSetSchema,
  ResyncRequestSchema,
  WaypointsDeleteSchema,
  WebMapCommandSchema,
  WebMapHandshakeRequestSchema,
  WireChannel,
  WireEnvelopeSchema,
  type WireEnvelope,
} from './proto/teamviewer/v1/teamviewer_pb';

export type PlayerData = {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  dimension: string;
  playerName?: string | null;
  playerUUID?: string | null;
  health?: number;
  maxHealth?: number;
  armor?: number;
  isRiding?: boolean;
  width?: number;
  height?: number;
};

export type EntityData = {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  dimension: string;
  entityType?: string | null;
  entityName?: string | null;
  width?: number;
  height?: number;
};

export type WaypointData = {
  x: number;
  y: number;
  z: number;
  dimension: string;
  name: string;
  symbol?: string | null;
  color?: number;
  ownerId?: string | null;
  ownerName?: string | null;
  createdAt?: number | null;
  ttlSeconds?: number | null;
  waypointKind?: string | null;
  replaceOldQuick?: boolean | null;
  maxQuickMarks?: number | null;
  targetType?: string | null;
  targetEntityId?: string | null;
  targetEntityType?: string | null;
  targetEntityName?: string | null;
  roomCode?: string | null;
  permanent?: boolean | null;
  tacticalType?: string | null;
  sourceType?: string | null;
};

export type BattleChunkData = {
  chunkX: number;
  chunkZ: number;
  dimension: string;
  symbol?: string | null;
  markerType?: string | null;
  colorRaw: string;
  colorNote?: string | null;
  roomCode?: string | null;
  colorMode?: string | null;
  colorSemanticKey?: string | null;
  mode?: string | null;
  observedAt?: number | null;
  positionSampledAt?: number | null;
  alignmentSource?: string | null;
  reporterId?: string | null;
};

export const PLAYER_DATA_RELIABILITY: Record<string, boolean> = {
  x: false,
  y: false,
  z: false,
  vx: false,
  vy: false,
  vz: false,
  dimension: false,
  playerName: true,
  playerUUID: true,
  health: true,
  maxHealth: true,
  armor: true,
  isRiding: true,
  width: false,
  height: false,
};

export const ENTITY_DATA_RELIABILITY: Record<string, boolean> = {
  x: false,
  y: false,
  z: false,
  vx: false,
  vy: false,
  vz: false,
  dimension: false,
  entityType: true,
  entityName: true,
  width: false,
  height: false,
};

export const WAYPOINT_DATA_RELIABILITY: Record<string, boolean> = {
  x: false,
  y: false,
  z: false,
  dimension: false,
  name: true,
  symbol: true,
  color: true,
  ownerId: true,
  ownerName: true,
  createdAt: true,
  ttlSeconds: true,
  waypointKind: true,
  replaceOldQuick: true,
  maxQuickMarks: true,
  targetType: true,
  targetEntityId: true,
  targetEntityType: true,
  targetEntityName: true,
  roomCode: true,
  permanent: true,
  tacticalType: true,
  sourceType: true,
};

export const BATTLE_CHUNK_DATA_RELIABILITY: Record<string, boolean> = {
  chunkX: true,
  chunkZ: true,
  dimension: true,
  symbol: true,
  markerType: true,
  colorRaw: true,
  colorNote: true,
  roomCode: true,
  colorMode: true,
  colorSemanticKey: true,
  mode: true,
  observedAt: true,
  positionSampledAt: true,
  alignmentSource: true,
  reporterId: true,
};

export type PlayerNode = {
  source?: string;
  timestamp?: number;
  data?: PlayerData;
} | PlayerData;

export type EntityNode = {
  source?: string;
  timestamp?: number;
  data?: EntityData;
} | EntityData;

export type WaypointNode = {
  source?: string;
  timestamp?: number;
  data?: WaypointData;
} | WaypointData;

export type BattleChunkNode = {
  source?: string;
  timestamp?: number;
  data?: BattleChunkData;
} | BattleChunkData;

export type WebMapSnapshot = {
  players: Record<string, PlayerNode>;
  entities: Record<string, EntityNode>;
  waypoints: Record<string, WaypointNode>;
  battleChunks: Record<string, BattleChunkNode>;
  playerMarks: Record<string, any>;
  tabState: { enabled: boolean; roomCode?: string; reports: Record<string, any>; groups: any[] };
  connections: string[];
  connections_count: number;
  server_time: number | null;
};

export type WebMapOutboundPacket = WireEnvelope;

export type WebMapAckInboundPacket = {
  type: 'web_map_ack';
  ok: boolean;
  error?: string;
  action?: string;
  [key: string]: unknown;
};

export type HandshakeAckInboundPacket = {
  type: 'handshake_ack';
  ready?: boolean;
  networkProtocolVersion?: string;
  minimumCompatibleNetworkProtocolVersion?: string;
  localProgramVersion?: string;
  error?: string;
  rejectReason?: string;
  [key: string]: unknown;
};

export type PongInboundPacket = {
  type: 'pong';
  [key: string]: unknown;
};

export type SnapshotFullInboundPacket = {
  type: 'snapshot_full';
  players?: Record<string, PlayerNode>;
  entities?: Record<string, EntityNode>;
  waypoints?: Record<string, WaypointNode>;
  battleChunks?: Record<string, BattleChunkNode>;
  playerMarks?: Record<string, unknown>;
  tabState?: { enabled: boolean; roomCode?: string; reports: Record<string, any>; groups: any[] };
  connections?: string[];
  connections_count?: number;
  server_time?: number | null;
  [key: string]: unknown;
};

export type TabStatePatch = {
  enabled?: boolean;
  roomCode?: string;
  groups?: any[];
  upsertReports?: Record<string, any>;
  deleteReports?: string[];
};

export type ScopePatch = {
  upsert?: Record<string, unknown>;
  delete?: string[];
};

export type PatchInboundPacket = {
  type: 'patch';
  players?: ScopePatch;
  entities?: ScopePatch;
  waypoints?: ScopePatch;
  battleChunks?: ScopePatch;
  playerMarks?: ScopePatch;
  meta?: Record<string, unknown>;
  server_time?: number | null;
  [key: string]: unknown;
};

export type BattleChunkMetaSnapshotInboundPacket = {
  type: 'battle_chunk_meta_snapshot';
  battleChunks?: Record<string, BattleChunkNode>;
  [key: string]: unknown;
};

export type WebMapInboundPacket =
  | WebMapAckInboundPacket
  | HandshakeAckInboundPacket
  | PongInboundPacket
  | SnapshotFullInboundPacket
  | PatchInboundPacket
  | BattleChunkMetaSnapshotInboundPacket;

export function createEmptyWebMapSnapshotModel(): WebMapSnapshot {
  return {
    players: {},
    entities: {},
    waypoints: {},
    battleChunks: {},
    playerMarks: {},
    tabState: { enabled: false, roomCode: '', reports: {}, groups: [] },
    connections: [],
    connections_count: 0,
    server_time: null,
  };
}

function createWebMapEnvelope(payload: WireEnvelope['payload']): WebMapOutboundPacket {
  return create(WireEnvelopeSchema, {
    channel: WireChannel.WEB_MAP,
    payload,
  });
}

function parseBattleChunkSyntheticId(chunkId: string) {
  const parts = String(chunkId || '').trim().split('|');
  if (parts.length !== 3) {
    return null;
  }
  const dimension = normalizeDimension(parts[0]) || '';
  const chunkX = Number(parts[1]);
  const chunkZ = Number(parts[2]);
  if (!dimension || !Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) {
    return null;
  }
  return {
    dimension,
    chunkX: Math.trunc(chunkX),
    chunkZ: Math.trunc(chunkZ),
  };
}

export function buildWebMapHandshake(roomCode: string): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapHandshakeRequest',
    value: create(WebMapHandshakeRequestSchema, {
      networkProtocolVersion: ADMIN_NETWORK_PROTOCOL_VERSION,
      minimumCompatibleNetworkProtocolVersion: ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION,
      localProgramVersion: LOCAL_PROGRAM_VERSION,
      roomCode: normalizeRoomCode(roomCode),
    }),
  });
}

export function buildCommandPlayerMarkSet(payload: {
  playerId: string;
  team: string;
  color: string;
  label?: string;
  source: 'auto' | 'manual';
}): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'setPlayerMark',
        value: create(CommandPlayerMarkSetSchema, {
          playerId: payload.playerId,
          team: payload.team,
          color: payload.color,
          label: payload.label,
          source: payload.source,
        }),
      },
    }),
  });
}

export function buildCommandPlayerMarkClear(playerId: string): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'clearPlayerMark',
        value: create(CommandPlayerMarkClearSchema, {
          playerId,
        }),
      },
    }),
  });
}

export function buildCommandPlayerMarkClearAll(): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'clearAllPlayerMarks',
        value: create(CommandPlayerMarkClearAllSchema, {}),
      },
    }),
  });
}

export function buildCommandSameServerFilterSet(enabled: boolean): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'setSameServerFilter',
        value: create(CommandSameServerFilterSetSchema, {
          enabled: Boolean(enabled),
        }),
      },
    }),
  });
}

export function buildCommandTacticalWaypointSet(payload: {
  x: number;
  z: number;
  label: string;
  tacticalType: string;
  color: string;
  ttlSeconds: number;
  permanent: boolean;
  roomCode: string;
  dimension: string;
}): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'setTacticalWaypoint',
        value: create(CommandTacticalWaypointSetSchema, {
          x: payload.x,
          z: payload.z,
          label: payload.label,
          tacticalType: payload.tacticalType,
          color: payload.color,
          ttlSeconds: payload.ttlSeconds,
          permanent: payload.permanent,
          roomCode: normalizeRoomCode(payload.roomCode),
          dimension: normalizeDimension(payload.dimension) || 'minecraft:overworld',
        }),
      },
    }),
  });
}

export function buildCommandTacticalWaypointDelete(waypointId: string): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'deleteWaypoints',
        value: create(WaypointsDeleteSchema, {
          waypointIds: [String(waypointId || '').trim()].filter(Boolean),
        }),
      },
    }),
  });
}

export function buildWebMapResyncRequest(reason = 'baseline_missing'): WebMapOutboundPacket {
  return createWebMapEnvelope({
    case: 'webMapCommand',
    value: create(WebMapCommandSchema, {
      command: {
        case: 'resyncRequest',
        value: create(ResyncRequestSchema, {
          reason,
        }),
      },
    }),
  });
}

export function buildBattleChunkMetaRequest(chunkIds: string[]): WebMapOutboundPacket {
  const battleChunks = Array.isArray(chunkIds)
    ? chunkIds
      .map((chunkId) => parseBattleChunkSyntheticId(chunkId))
      .filter((item): item is NonNullable<ReturnType<typeof parseBattleChunkSyntheticId>> => Boolean(item))
      .map((item) => ({
        dimension: item.dimension,
        coord: {
          chunkX: item.chunkX,
          chunkZ: item.chunkZ,
        },
      }))
    : [];
  return createWebMapEnvelope({
    case: 'battleChunkMetaRequest',
    value: create(BattleChunkMetaRequestSchema, {
      battleChunks,
    }),
  });
}

export function parseWebMapInboundPacket(payload: unknown): WebMapInboundPacket | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const message = payload as Record<string, unknown>;
  const type = typeof message.type === 'string' ? message.type : '';
  if (!type) {
    return null;
  }

  switch (type) {
    case 'web_map_ack':
    case 'handshake_ack':
    case 'pong':
    case 'snapshot_full':
    case 'patch':
    case 'battle_chunk_meta_snapshot':
      return message as WebMapInboundPacket;
    default:
      return null;
  }
}
