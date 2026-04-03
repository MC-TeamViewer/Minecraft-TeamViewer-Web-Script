import type { WebMapInboundPacket, WebMapOutboundPacket, TabStatePatch } from './networkSchemas';
import {
  ADMIN_MIN_COMPATIBLE_NETWORK_PROTOCOL_VERSION,
} from '../constants';
import {
  applyScopePatchMap,
  shouldResyncForScopeMissingBaseline,
} from '../utils/overlayUtils';
import {
  WebMapSnapshot,
  buildWebMapHandshake,
  buildWebMapResyncRequest,
  createEmptyWebMapSnapshotModel,
} from './networkSchemas';
import { ProtobufNetworkMessageCodec } from './messageCodec';

type Snapshot = WebMapSnapshot & Record<string, any>;

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
};

const DEBUG_HISTORY_LIMIT = 30;

type WsClientDeps = {
  getConfig: () => Record<string, any>;
  isDebugEnabled?: () => boolean;
  onSnapshotChanged: (snapshot: Snapshot) => void;
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
  };

  function isDebugEnabled() {
    return Boolean(deps.isDebugEnabled?.());
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
      return JSON.parse(JSON.stringify(value)) as T;
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
    if (reconnectSuppressedByVersionIncompatibility) return;
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
    } catch (_) {
      return false;
    }
  }

  function applyWebMapDeltaMessage(message: WebMapInboundPacket) {
    if (!message || typeof message !== 'object') {
      return;
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
      deps.onSnapshotChanged(latestSnapshot);
      return;
    }

    if (message.type !== 'patch') {
      return;
    }

    if (!latestSnapshot || typeof latestSnapshot !== 'object') {
      requestResync('patch_before_full_snapshot');
      return;
    }

    const needResync =
      shouldResyncForScopeMissingBaseline(latestSnapshot.players, message.players, ['x', 'y', 'z', 'dimension']) ||
      shouldResyncForScopeMissingBaseline(latestSnapshot.entities, message.entities, ['x', 'y', 'z', 'dimension']) ||
      shouldResyncForScopeMissingBaseline(latestSnapshot.battleChunks, message.battleChunks, ['chunkX', 'chunkZ', 'dimension', 'colorRaw']);
    if (needResync) {
      requestResync('patch_missing_baseline');
    }

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

    deps.onSnapshotChanged(latestSnapshot);
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
    try {
      webMapWs.send(messageCodec.encode(message));
      return true;
    } catch (error: any) {
      lastErrorText = String(error?.message || error);
      emitStatus();
      return false;
    }
  }

  function cleanup() {
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

  function reconnect() {
    manualWsClose = true;
    cleanup();
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
    if (webMapWs && (webMapWs.readyState === WebSocket.OPEN || webMapWs.readyState === WebSocket.CONNECTING)) {
      return;
    }

    reconnectSuppressedByVersionIncompatibility = false;
    serverProtocolVersion = null;

    const config = deps.getConfig();

    let ws: WebSocket;
    try {
      ws = new WebSocket(config.ADMIN_WS_URL);
    } catch (error: any) {
      const text = String(error?.message || error);
      lastErrorText = text;
      emitStatus();
      scheduleReconnect();
      return;
    }

    webMapWs = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      wsConnected = true;
      lastErrorText = null;
      try {
        ws.send(messageCodec.encode(buildWebMapHandshake(config.ROOM_CODE)));
      } catch (error: any) {
        lastErrorText = String(error?.message || error);
      }
      emitStatus();
    };

    ws.onmessage = async (event) => {
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

        const payload = messageCodec.decode(rawPayload);
        if (!payload) {
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

          lastErrorText = null;
          emitStatus();
          return;
        }

        applyWebMapDeltaMessage(payload);
        lastErrorText = null;
        emitStatus();
      } catch (error: any) {
        lastErrorText = String(error?.message || error);
        emitStatus();
      }
    };

    ws.onerror = () => {
      wsConnected = false;
      if (!lastErrorText) {
        lastErrorText = 'ws error';
      }
      emitStatus();
    };

    ws.onclose = (event) => {
      wsConnected = false;
      webMapWs = null;
      if (!manualWsClose && !reconnectSuppressedByVersionIncompatibility) {
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
    };
  }

  return {
    connect,
    reconnect,
    cleanup,
    sendCommand,
    requestResync,
    isWsOpen,
    getSnapshot,
    getStatus,
    getDebugState,
    clearDebugHistory,
  };
}
