import type { WebMapInboundPacket, WebMapOutboundPacket, TabStatePatch } from './networkSchemas';
import {
  ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION,
} from '../constants';
import {
  applyScopePatchMap,
  shouldResyncForScopeMissingBaseline,
} from '../utils/overlayUtils';
import { normalizeDebugJsonValue } from '../utils/debugJson';
import {
  WebMapSnapshot,
  buildWebMapHandshake,
  buildWebMapResyncRequest,
  createEmptyWebMapSnapshotModel,
} from './networkSchemas';
import { ProtobufNetworkMessageCodec } from './messageCodec';

type Snapshot = WebMapSnapshot & Record<string, any>;

export type SnapshotScopeName =
  | 'players'
  | 'entities'
  | 'waypoints'
  | 'battleChunks'
  | 'playerMarks'
  | 'tabState'
  | 'connections';

export type SnapshotScopeFlags = Record<SnapshotScopeName, boolean>;
export type SnapshotScopeIdBuckets = Record<SnapshotScopeName, string[]>;

export type SnapshotChangeSet = {
  kind: 'full' | 'patch';
  dirtyScopes: SnapshotScopeFlags;
  upsertIds: SnapshotScopeIdBuckets;
  deleteIds: SnapshotScopeIdBuckets;
  hasWorldRenderImpact: boolean;
  perf: {
    decodeMs: number;
    mergeMs: number;
  };
};

type ScopeDebugCounts = {
  players: number;
  entities: number;
  waypoints: number;
  battleChunks: number;
  playerMarks: number;
  tabReports: number;
  connections: number;
};

type WsDebugMessageRecord = {
  receivedAt: number;
  type: string;
  channel: 'web_map';
  counts: ScopeDebugCounts;
  payload: Record<string, unknown> | null;
};

type WsDebugCloseEvent = {
  closedAt: number;
  code: number;
  reason: string;
  wasClean: boolean;
  manual: boolean;
  pageUnloading: boolean;
};

type WsDebugRuntimeError = {
  at: number;
  stage: string;
  message: string;
  stack: string | null;
};

type WsDebugState = {
  history: WsDebugMessageRecord[];
  lastInbound: WsDebugMessageRecord | null;
  lastHandshakeAck: WsDebugMessageRecord | null;
  lastSnapshotFull: WsDebugMessageRecord | null;
  lastPatch: WsDebugMessageRecord | null;
  lastWebMapAck: WsDebugMessageRecord | null;
  lastResyncRequest: {
    requestedAt: number;
    reason: string;
    sent: boolean;
  } | null;
  lastCloseEvent: WsDebugCloseEvent | null;
  lastRuntimeError: WsDebugRuntimeError | null;
  lastPerf: {
    decodeMs: number;
    mergeMs: number;
  } | null;
};

const DEBUG_HISTORY_LIMIT = 30;

type WsClientDeps = {
  getConfig: () => Record<string, any>;
  isDebugEnabled?: () => boolean;
  onSnapshotChanged: (snapshot: Snapshot, changeSet: SnapshotChangeSet) => void;
  onAckMessage: (payload: Record<string, any>) => void;
  onWsStatusChanged: (payload: {
    wsConnected: boolean;
    lastErrorText: string | null;
    lastWebMapMessageType: string | null;
    lastWebMapMessageAt: number;
    serverProtocolVersion: string | null;
  }) => void;
  onVersionIncompatible?: (payload: {
    message: string;
    serverProtocolVersion?: string;
    minimumCompatibleVersion?: string;
    rejectReason?: string;
  }) => void;
};

export function createEmptyWebMapSnapshot() {
  return createEmptyWebMapSnapshotModel();
}

export function createWebMapWsClient(deps: WsClientDeps) {
  const messageCodec = new ProtobufNetworkMessageCodec();
  let webMapWs: WebSocket | null = null;
  let wsConnected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let manualWsClose = false;
  let pageUnloading = false;
  let reconnectSuppressedByVersionIncompatibility = false;

  let lastErrorText: string | null = null;
  let lastWebMapResyncRequestAt = 0;
  let lastWebMapMessageType: string | null = null;
  let lastWebMapMessageAt = 0;
  let serverProtocolVersion: string | null = null;
  let latestSnapshot: Snapshot = createEmptyWebMapSnapshot();
  let debugState: WsDebugState = {
    history: [],
    lastInbound: null,
    lastHandshakeAck: null,
    lastSnapshotFull: null,
    lastPatch: null,
    lastWebMapAck: null,
    lastResyncRequest: null,
    lastCloseEvent: null,
    lastRuntimeError: null,
    lastPerf: null,
  };

  function isDebugEnabled() {
    return Boolean(deps.isDebugEnabled?.());
  }

  function createEmptyScopeFlags(): SnapshotScopeFlags {
    return {
      players: false,
      entities: false,
      waypoints: false,
      battleChunks: false,
      playerMarks: false,
      tabState: false,
      connections: false,
    };
  }

  function createEmptyScopeIdBuckets(): SnapshotScopeIdBuckets {
    return {
      players: [],
      entities: [],
      waypoints: [],
      battleChunks: [],
      playerMarks: [],
      tabState: [],
      connections: [],
    };
  }

  function hasObjectKeys(value: unknown) {
    return Boolean(value) && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0;
  }

  function getScopePatchIds(scopePatch: unknown) {
    const patchRecord = scopePatch && typeof scopePatch === 'object'
      ? scopePatch as Record<string, unknown>
      : null;
    const upsertIds = patchRecord?.upsert && typeof patchRecord.upsert === 'object'
      ? Object.keys(patchRecord.upsert as Record<string, unknown>)
      : [];
    const deleteIds = Array.isArray(patchRecord?.delete)
      ? patchRecord!.delete.map((item) => String(item || '')).filter(Boolean)
      : [];
    return { upsertIds, deleteIds };
  }

  function buildFullSnapshotChangeSet(snapshot: Snapshot, decodeMs: number): SnapshotChangeSet {
    const dirtyScopes = createEmptyScopeFlags();
    const upsertIds = createEmptyScopeIdBuckets();
    const deleteIds = createEmptyScopeIdBuckets();

    const scopedMaps: Array<Exclude<SnapshotScopeName, 'tabState' | 'connections'>> = [
      'players',
      'entities',
      'waypoints',
      'battleChunks',
      'playerMarks',
    ];

    for (const scopeName of scopedMaps) {
      const record = snapshot?.[scopeName];
      if (!record || typeof record !== 'object') continue;
      upsertIds[scopeName] = Object.keys(record);
      dirtyScopes[scopeName] = true;
    }

    dirtyScopes.tabState = true;
    dirtyScopes.connections = true;
    upsertIds.tabState = snapshot?.tabState?.reports && typeof snapshot.tabState.reports === 'object'
      ? Object.keys(snapshot.tabState.reports)
      : [];
    upsertIds.connections = Array.isArray(snapshot?.connections)
      ? snapshot.connections.map((item) => String(item || '')).filter(Boolean)
      : [];

    return {
      kind: 'full',
      dirtyScopes,
      upsertIds,
      deleteIds,
      hasWorldRenderImpact: true,
      perf: {
        decodeMs,
        mergeMs: 0,
      },
    };
  }

  function buildPatchChangeSet(message: WebMapInboundPacket, decodeMs: number, mergeMs: number): SnapshotChangeSet {
    const dirtyScopes = createEmptyScopeFlags();
    const upsertIds = createEmptyScopeIdBuckets();
    const deleteIds = createEmptyScopeIdBuckets();

    const scopedMaps: Array<Exclude<SnapshotScopeName, 'tabState' | 'connections'>> = [
      'players',
      'entities',
      'waypoints',
      'battleChunks',
      'playerMarks',
    ];

    for (const scopeName of scopedMaps) {
      const scopePatch = (message as Record<string, unknown>)[scopeName];
      const ids = getScopePatchIds(scopePatch);
      upsertIds[scopeName] = ids.upsertIds;
      deleteIds[scopeName] = ids.deleteIds;
      dirtyScopes[scopeName] = ids.upsertIds.length > 0 || ids.deleteIds.length > 0;
    }

    const meta = message.type === 'patch' && message.meta && typeof message.meta === 'object'
      ? message.meta as Record<string, unknown>
      : null;
    const metaTabState = meta?.tabState;
    const metaTabStatePatch = meta?.tabStatePatch;
    const metaConnections = meta?.connections;

    if (metaTabState && typeof metaTabState === 'object') {
      dirtyScopes.tabState = true;
      upsertIds.tabState = ['tabState'];
    }

    if (metaTabStatePatch && typeof metaTabStatePatch === 'object') {
      dirtyScopes.tabState = true;
      const reportsPatch = metaTabStatePatch as Record<string, unknown>;
      upsertIds.tabState = reportsPatch.upsertReports && typeof reportsPatch.upsertReports === 'object'
        ? Object.keys(reportsPatch.upsertReports as Record<string, unknown>)
        : upsertIds.tabState;
      deleteIds.tabState = Array.isArray(reportsPatch.deleteReports)
        ? reportsPatch.deleteReports.map((item) => String(item || '')).filter(Boolean)
        : [];
    }

    if (Array.isArray(metaConnections)) {
      dirtyScopes.connections = true;
      upsertIds.connections = metaConnections.map((item) => String(item || '')).filter(Boolean);
    }

    return {
      kind: 'patch',
      dirtyScopes,
      upsertIds,
      deleteIds,
      hasWorldRenderImpact:
        dirtyScopes.players ||
        dirtyScopes.entities ||
        dirtyScopes.waypoints ||
        dirtyScopes.battleChunks ||
        dirtyScopes.playerMarks ||
        dirtyScopes.tabState ||
        dirtyScopes.connections,
      perf: {
        decodeMs,
        mergeMs,
      },
    };
  }

  function getScopeCount(value: unknown) {
    if (!value || typeof value !== 'object') return 0;
    const record = value as Record<string, unknown>;
    if (record.upsert || record.delete) {
      const upsertCount = record.upsert && typeof record.upsert === 'object'
        ? Object.keys(record.upsert as Record<string, unknown>).length
        : 0;
      const deleteCount = Array.isArray(record.delete) ? record.delete.length : 0;
      return upsertCount + deleteCount;
    }
    return Object.keys(record).length;
  }

  function getCountsFromPayload(payload: Record<string, unknown> | null | undefined): ScopeDebugCounts {
    const tabState = payload?.tabState;
    const reports = tabState && typeof tabState === 'object'
      ? (tabState as Record<string, unknown>).reports
      : null;
    return {
      players: getScopeCount(payload?.players),
      entities: getScopeCount(payload?.entities),
      waypoints: getScopeCount(payload?.waypoints),
      battleChunks: getScopeCount(payload?.battleChunks),
      playerMarks: getScopeCount(payload?.playerMarks),
      tabReports: getScopeCount(reports),
      connections: Array.isArray(payload?.connections) ? payload.connections.length : 0,
    };
  }

  function cloneForDebug<T>(value: T): T {
    try {
      return normalizeDebugJsonValue(value, {
        omitUndefined: false,
        includeTypeName: true,
      }) as T;
    } catch (_) {
      return value;
    }
  }

  function recordInboundMessage(payload: WebMapInboundPacket) {
    if (!isDebugEnabled()) {
      return;
    }
    const payloadRecord = payload && typeof payload === 'object'
      ? cloneForDebug(payload as Record<string, unknown>)
      : null;
    const record: WsDebugMessageRecord = {
      receivedAt: Date.now(),
      type: payload?.type ? String(payload.type) : 'unknown',
      channel: 'web_map',
      counts: getCountsFromPayload(payloadRecord),
      payload: payloadRecord,
    };

    debugState = {
      ...debugState,
      history: [record, ...debugState.history].slice(0, DEBUG_HISTORY_LIMIT),
      lastInbound: record,
      lastHandshakeAck: record.type === 'handshake_ack' ? record : debugState.lastHandshakeAck,
      lastSnapshotFull: record.type === 'snapshot_full' ? record : debugState.lastSnapshotFull,
      lastPatch: record.type === 'patch' ? record : debugState.lastPatch,
      lastWebMapAck: record.type === 'web_map_ack' ? record : debugState.lastWebMapAck,
    };
  }

  function getErrorMessage(error: unknown) {
    if (error instanceof Error) {
      return error.message || String(error);
    }
    return String(error ?? 'unknown_error');
  }

  function recordRuntimeError(stage: string, error: unknown) {
    const message = getErrorMessage(error);
    const stack = error instanceof Error && typeof error.stack === 'string'
      ? error.stack
      : null;
    console.error(`[TeamViewRelay Overlay] web-map ${stage} failed`, error);
    if (isDebugEnabled()) {
      debugState = {
        ...debugState,
        lastRuntimeError: {
          at: Date.now(),
          stage,
          message,
          stack,
        },
      };
    }
    lastErrorText = message;
  }

  function recordCloseEvent(event: CloseEvent) {
    if (!isDebugEnabled()) {
      return;
    }
    debugState = {
      ...debugState,
      lastCloseEvent: {
        closedAt: Date.now(),
        code: Number(event?.code || 0),
        reason: String(event?.reason || ''),
        wasClean: Boolean(event?.wasClean),
        manual: manualWsClose,
        pageUnloading,
      },
    };
  }

  function emitStatus() {
    deps.onWsStatusChanged({
      wsConnected,
      lastErrorText,
      lastWebMapMessageType,
      lastWebMapMessageAt,
      serverProtocolVersion,
    });
  }

  function scheduleReconnect() {
    if (pageUnloading || reconnectSuppressedByVersionIncompatibility) return;
    if (reconnectTimer !== null) return;
    const config = deps.getConfig();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, config.RECONNECT_INTERVAL_MS);
  }

  function requestResync(reason = 'baseline_missing') {
    const textReason = String(reason || 'baseline_missing').trim() || 'baseline_missing';
    if (!webMapWs || webMapWs.readyState !== WebSocket.OPEN) {
      if (isDebugEnabled()) {
        debugState = {
          ...debugState,
          lastResyncRequest: {
            requestedAt: Date.now(),
            reason: textReason,
            sent: false,
          },
        };
      }
      return false;
    }
    const now = Date.now();
    if (now - lastWebMapResyncRequestAt < 1500) {
      return false;
    }
    lastWebMapResyncRequestAt = now;
    if (isDebugEnabled()) {
      debugState = {
        ...debugState,
        lastResyncRequest: {
          requestedAt: now,
          reason: textReason,
          sent: true,
        },
      };
    }
    try {
      webMapWs.send(messageCodec.encode(buildWebMapResyncRequest(textReason)));
      return true;
    } catch (error) {
      recordRuntimeError('send_resync_request', error);
      emitStatus();
      return false;
    }
  }

  function applyWebMapDeltaMessage(message: WebMapInboundPacket, decodeMs = 0) {
    if (!message || typeof message !== 'object') {
      return null;
    }

    if (message.type === 'snapshot_full') {
      latestSnapshot = {
        players: (message.players && typeof message.players === 'object') ? message.players : {},
        entities: (message.entities && typeof message.entities === 'object') ? message.entities : {},
        waypoints: (message.waypoints && typeof message.waypoints === 'object') ? message.waypoints : {},
        battleChunks: (message.battleChunks && typeof message.battleChunks === 'object') ? message.battleChunks : {},
        playerMarks: (message.playerMarks && typeof message.playerMarks === 'object') ? message.playerMarks : {},
        tabState: (message.tabState && typeof message.tabState === 'object') ? message.tabState : { enabled: false, reports: {}, groups: [] },
        connections: Array.isArray(message.connections) ? message.connections : [],
        connections_count: Number.isFinite(message.connections_count) ? message.connections_count : 0,
        server_time: message.server_time,
      };
      return buildFullSnapshotChangeSet(latestSnapshot, decodeMs);
    }

    if (message.type !== 'patch') {
      return null;
    }

    if (!latestSnapshot || typeof latestSnapshot !== 'object') {
      requestResync('patch_before_full_snapshot');
      return null;
    }

    const needResync =
      shouldResyncForScopeMissingBaseline(latestSnapshot.players, message.players, ['x', 'y', 'z', 'dimension']) ||
      shouldResyncForScopeMissingBaseline(latestSnapshot.entities, message.entities, ['x', 'y', 'z', 'dimension']) ||
      shouldResyncForScopeMissingBaseline(latestSnapshot.battleChunks, message.battleChunks, ['chunkX', 'chunkZ', 'dimension', 'colorRaw']);
    if (needResync) {
      requestResync('patch_missing_baseline');
    }

    const mergeStartAt = performance.now();
    latestSnapshot.players = applyScopePatchMap(latestSnapshot.players, message.players, ['x', 'y', 'z', 'dimension']);
    latestSnapshot.entities = applyScopePatchMap(latestSnapshot.entities, message.entities, ['x', 'y', 'z', 'dimension']);
    latestSnapshot.waypoints = applyScopePatchMap(latestSnapshot.waypoints, message.waypoints);
    latestSnapshot.battleChunks = applyScopePatchMap(latestSnapshot.battleChunks, message.battleChunks, ['chunkX', 'chunkZ', 'dimension', 'colorRaw']);
    latestSnapshot.playerMarks = applyScopePatchMap(latestSnapshot.playerMarks, message.playerMarks);

    const meta = (message.meta && typeof message.meta === 'object') ? message.meta : {};
    const metaTabState = (meta as Record<string, unknown>).tabState;
    if (metaTabState && typeof metaTabState === 'object') {
      latestSnapshot.tabState = metaTabState as { enabled: boolean; roomCode?: string; reports: Record<string, any>; groups: any[] };
    }

    const metaTabStatePatch = (meta as Record<string, unknown>).tabStatePatch;
    if (metaTabStatePatch && typeof metaTabStatePatch === 'object') {
      latestSnapshot.tabState = applyTabStatePatch(
        latestSnapshot.tabState,
        metaTabStatePatch as TabStatePatch,
      );
    }
    const metaConnections = (meta as Record<string, unknown>).connections;
    if (Array.isArray(metaConnections)) {
      latestSnapshot.connections = metaConnections as string[];
    }
    const metaConnectionsCount = (meta as Record<string, unknown>).connections_count;
    if (Number.isFinite(metaConnectionsCount)) {
      latestSnapshot.connections_count = Number(metaConnectionsCount);
    }

    if (message.server_time !== undefined) {
      latestSnapshot.server_time = message.server_time;
    }

    const mergeMs = Math.max(0, performance.now() - mergeStartAt);
    return buildPatchChangeSet(message, decodeMs, mergeMs);
  }

  function applyTabStatePatch(
    currentTabState: { enabled: boolean; roomCode?: string; reports: Record<string, any>; groups: any[] } | null | undefined,
    patch: TabStatePatch,
  ) {
    const base = currentTabState && typeof currentTabState === 'object'
      ? currentTabState
      : { enabled: false, reports: {}, groups: [] };
    const nextReports = { ...(base.reports && typeof base.reports === 'object' ? base.reports : {}) };

    if (patch.upsertReports && typeof patch.upsertReports === 'object') {
      for (const [sourceId, report] of Object.entries(patch.upsertReports)) {
        nextReports[sourceId] = report;
      }
    }

    if (Array.isArray(patch.deleteReports)) {
      for (const sourceId of patch.deleteReports) {
        delete nextReports[String(sourceId)];
      }
    }

    return {
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : Boolean(base.enabled),
      roomCode: patch.roomCode !== undefined ? String(patch.roomCode || '') : base.roomCode,
      reports: nextReports,
      groups: Array.isArray(patch.groups) ? patch.groups : (Array.isArray(base.groups) ? base.groups : []),
    };
  }

  function sendCommand(message: WebMapOutboundPacket) {
    if (!webMapWs || webMapWs.readyState !== WebSocket.OPEN) {
      lastErrorText = 'ws not connected';
      emitStatus();
      return false;
    }
    if (!wsConnected) {
      lastErrorText = 'ws handshake not completed';
      emitStatus();
      return false;
    }
    try {
      webMapWs.send(messageCodec.encode(message));
      return true;
    } catch (error: any) {
      recordRuntimeError('send_command', error);
      emitStatus();
      return false;
    }
  }

  function cleanup(options: { manualClose?: boolean } = {}) {
    if (options.manualClose) {
      manualWsClose = true;
    }
    if (webMapWs) {
      webMapWs.onopen = null;
      webMapWs.onmessage = null;
      webMapWs.onerror = null;
      webMapWs.onclose = null;
      try {
        webMapWs.close();
      } catch (_) {}
      webMapWs = null;
    }
    wsConnected = false;
    if (reconnectTimer !== null) {
      try { clearTimeout(reconnectTimer); } catch (_) {}
      reconnectTimer = null;
    }
  }

  function prepareForPageUnload() {
    pageUnloading = true;
    cleanup({ manualClose: true });
  }

  function reconnect() {
    pageUnloading = false;
    cleanup({ manualClose: true });
    manualWsClose = false;
    reconnectSuppressedByVersionIncompatibility = false;
    lastErrorText = null;
    serverProtocolVersion = null;
    connect();
    emitStatus();
  }

  function parseProtocolVersionNumber(version: unknown): number {
    const raw = String(version ?? '').trim();
    if (!raw) return 0;
    const core = raw.split('-', 1)[0] || '';
    const parts = core.split('.');
    const nums = [0, 0, 0].map((_, index) => {
      const token = String(parts[index] ?? '').trim();
      const match = token.match(/^(\d+)/);
      return match ? Number(match[1]) : 0;
    });
    return nums[0] * 1_000_000 + nums[1] * 1_000 + nums[2];
  }

  function protocolAtLeast(current: unknown, minimum: unknown): boolean {
    return parseProtocolVersionNumber(current) >= parseProtocolVersionNumber(minimum);
  }

  function formatHandshakeRejectReason(payload: Record<string, unknown>): string {
    const text = String(payload.rejectReason ?? payload.error ?? '').trim();
    return text || 'unknown';
  }

  function forceCloseForIncompatibleVersion(
    message: string,
    details?: {
      serverProtocolVersion?: string;
      minimumCompatibleVersion?: string;
      rejectReason?: string;
    },
  ) {
    reconnectSuppressedByVersionIncompatibility = true;
    wsConnected = false;
    lastErrorText = message;
    try {
      deps.onVersionIncompatible?.({
        message,
        serverProtocolVersion: details?.serverProtocolVersion,
        minimumCompatibleVersion: details?.minimumCompatibleVersion,
        rejectReason: details?.rejectReason,
      });
    } catch (_) {}
    if (webMapWs) {
      try {
        webMapWs.close(1008, message.slice(0, 120));
      } catch (_) {
        try { webMapWs.close(); } catch (_) {}
      }
    }
    emitStatus();
  }

  function connect() {
    if (pageUnloading) {
      return;
    }
    if (webMapWs && (webMapWs.readyState === WebSocket.OPEN || webMapWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    manualWsClose = false;
    pageUnloading = false;
    reconnectSuppressedByVersionIncompatibility = false;
    wsConnected = false;
    serverProtocolVersion = null;

    const config = deps.getConfig();

    let ws: WebSocket;
    try {
      ws = new WebSocket(config.ADMIN_WS_URL);
    } catch (error: any) {
      recordRuntimeError('create_socket', error);
      emitStatus();
      scheduleReconnect();
      return;
    }

    webMapWs = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      wsConnected = false;
      lastErrorText = null;
      try {
        ws.send(messageCodec.encode(buildWebMapHandshake(config.ROOM_CODE)));
      } catch (error: any) {
        recordRuntimeError('send_handshake', error);
      }
      emitStatus();
    };

    ws.onmessage = async (event) => {
      let currentStage = 'read_message';
      try {
        const data = event?.data;
        let rawPayload: ArrayBuffer | Uint8Array | string | null = null;
        if (data instanceof ArrayBuffer) {
          rawPayload = data;
        } else if (typeof data === 'string') {
          rawPayload = data;
        } else if (data && typeof (data as Blob).arrayBuffer === 'function') {
          rawPayload = await (data as Blob).arrayBuffer();
        }
        if (rawPayload == null) return;

        const decodeStartedAt = performance.now();
        currentStage = 'decode_message';
        const payload = messageCodec.decode(rawPayload);
        const decodeMs = Math.max(0, performance.now() - decodeStartedAt);
        if (!payload) {
          recordRuntimeError(currentStage, new Error('unsupported_or_undecodable_websocket_payload'));
          emitStatus();
          return;
        }
        recordInboundMessage(payload);
        lastWebMapMessageType = payload?.type ? String(payload.type) : 'unknown';
        lastWebMapMessageAt = Date.now();

        if (payload?.type === 'web_map_ack') {
          if (payload.ok) {
            lastErrorText = null;
          } else if (payload.error) {
            lastErrorText = `命令失败: ${payload.error}`;
          }
          deps.onAckMessage(payload);
          emitStatus();
          return;
        }

        if (payload?.type === 'pong') {
          lastErrorText = null;
          emitStatus();
          return;
        }

        if (payload?.type === 'handshake_ack') {
          const handshakePayload = payload as Record<string, unknown>;
          serverProtocolVersion = String(handshakePayload.networkProtocolVersion ?? '').trim() || null;
          if (handshakePayload.ready === false) {
            const reason = formatHandshakeRejectReason(handshakePayload);
            forceCloseForIncompatibleVersion(`服务端拒绝握手: ${reason}`, {
              serverProtocolVersion: serverProtocolVersion || undefined,
              rejectReason: reason,
            });
            return;
          }

          const negotiatedServerProtocolVersion = serverProtocolVersion || '0.0.0';
          if (!protocolAtLeast(negotiatedServerProtocolVersion, ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION)) {
            forceCloseForIncompatibleVersion(
              `版本不兼容: 服务端协议 ${negotiatedServerProtocolVersion} 低于脚本最低要求 ${ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION}`,
              {
                serverProtocolVersion: negotiatedServerProtocolVersion,
                minimumCompatibleVersion: ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION,
              },
            );
            return;
          }

          wsConnected = true;
          lastErrorText = null;
          emitStatus();
          return;
        }

        currentStage = `apply_${String(payload?.type || 'message')}`;
        const changeSet = applyWebMapDeltaMessage(payload, decodeMs);
        if (changeSet) {
          if (isDebugEnabled()) {
            debugState = {
              ...debugState,
              lastPerf: {
                decodeMs: changeSet.perf.decodeMs,
                mergeMs: changeSet.perf.mergeMs,
              },
            };
          }
          deps.onSnapshotChanged(latestSnapshot, changeSet);
        }
        lastErrorText = null;
        emitStatus();
      } catch (error: any) {
        recordRuntimeError(currentStage, error);
        emitStatus();
      }
    };

    ws.onerror = (event) => {
      wsConnected = false;
      if (!lastErrorText) {
        lastErrorText = 'ws error';
      }
      if (isDebugEnabled()) {
        debugState = {
          ...debugState,
          lastRuntimeError: {
            at: Date.now(),
            stage: 'socket_error_event',
            message: String(event?.type || 'ws error'),
            stack: null,
          },
        };
      }
      emitStatus();
    };

    ws.onclose = (event) => {
      wsConnected = false;
      webMapWs = null;
      recordCloseEvent(event);
      if (!manualWsClose && !pageUnloading && !reconnectSuppressedByVersionIncompatibility) {
        scheduleReconnect();
      } else if (reconnectSuppressedByVersionIncompatibility && !lastErrorText) {
        const reason = String(event?.reason || '').trim();
        lastErrorText = reason || '版本不兼容，已停止自动重连';
      }
      emitStatus();
    };
  }

  function isWsOpen() {
    return !!webMapWs && webMapWs.readyState === WebSocket.OPEN;
  }

  function getSnapshot() {
    return latestSnapshot;
  }

  function getStatus() {
    return {
      wsConnected,
      lastErrorText,
      lastWebMapMessageType,
      lastWebMapMessageAt,
      serverProtocolVersion,
      wsReadyState: webMapWs ? webMapWs.readyState : -1,
    };
  }

  function getDebugState() {
    if (!isDebugEnabled()) {
      return {
        history: [],
        lastInbound: null,
        lastHandshakeAck: null,
        lastSnapshotFull: null,
        lastPatch: null,
        lastWebMapAck: null,
        lastResyncRequest: null,
        lastCloseEvent: null,
        lastRuntimeError: null,
        lastPerf: null,
      };
    }
    return cloneForDebug(debugState);
  }

  function clearDebugHistory() {
    debugState = {
      history: [],
      lastInbound: null,
      lastHandshakeAck: null,
      lastSnapshotFull: null,
      lastPatch: null,
      lastWebMapAck: null,
      lastResyncRequest: null,
      lastCloseEvent: null,
      lastRuntimeError: null,
      lastPerf: null,
    };
  }

  return {
    connect,
    reconnect,
    cleanup,
    prepareForPageUnload,
    sendCommand,
    requestResync,
    isWsOpen,
    getSnapshot,
    getStatus,
    getDebugState,
    clearDebugHistory,
  };
}
