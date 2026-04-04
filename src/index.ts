// @ts-nocheck
import {
  DEFAULT_CONFIG,
  STORAGE_KEY,
  ADMIN_NETWORK_PROTOCOL_VERSION,
} from './constants';
import {
  buildExportFileName,
  createConfigExportPayload,
  getConfigCompatVersion,
  parseImportedConfigText,
} from './config/configTransfer';
import { OVERLAY_STYLE_TEXT, UI_STYLE_TEXT } from './ui/styles';
import {
  getConfiguredTeamColor,
  normalizeColor,
  normalizeDimension,
  normalizeMarkSource,
  normalizeRoomCode,
  normalizeTeam,
  normalizeWsUrl,
  parseMcDisplayName,
  parseTagList,
  readNumber,
  sanitizeConfig,
  getPlayerDataNode,
} from './utils/overlayUtils';
import { normalizeDebugJsonValue, stringifyDebugJson } from './utils/debugJson';
import { createAutoMarkSyncManager } from './core/autoMarkSync';
import {
  buildCommandPlayerMarkClear,
  buildCommandPlayerMarkClearAll,
  buildCommandPlayerMarkSet,
  buildCommandSameServerFilterSet,
  buildCommandTacticalWaypointDelete,
  buildCommandTacticalWaypointSet,
} from './network/networkSchemas';
import { createWebMapWsClient, type SnapshotChangeSet } from './network/wsClient';
import { createMapProjection } from './core/mapProjection';
import { createSettingsUi } from './ui/settingsUi';

(function () {
  'use strict';

  const PAGE = window;
  const CONFIG = { ...DEFAULT_CONFIG };

  let latestSnapshot: Record<string, any> | null = null;
  let latestPlayerMarks: Record<string, any> = {};
  let lastErrorText: string | null = null;
  let wsConnected = false;
  let sameServerFilterEnabled = false;
  let overlayStarted = false;
  let lastWebMapMessageType: string | null = null;
  let lastWebMapMessageAt = 0;
  let versionIncompatibilityAlerted = false;
  let serverProtocolVersion: string | null = null;
  let pageUnloading = false;
  let deferredBootStarted = false;
  let overlayStartTimer: ReturnType<typeof setTimeout> | null = null;
  let uiSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let uiStatusTimer: ReturnType<typeof setTimeout> | null = null;
  let startupObserver: MutationObserver | null = null;
  let pendingUiDimensionRefresh = false;
  let pendingUiDebugRefresh = false;
  let cachedDimensionOptions = getOverviewDimensionOptions(null, CONFIG.TARGET_DIMENSION);
  let lastUiRefreshDurationMs = 0;
  let lastPlayerDeriveMs = 0;
  let lastPlayerUiFlushMs = 0;
  let onlinePlayerCount = 0;
  let visibleMapPlayerCount = 0;
  let playerSelectorDirty = true;
  let mapPlayerListDirty = true;
  let cachedFriendlyTags: string[] = [];
  let cachedEnemyTags: string[] = [];
  let cachedAutoTeamTagsKey = '';

  type TabPlayerInfo = {
    name: string;
    teamText: string;
    teamColor: string | null;
    autoName: string | null;
    displayNameRaw: string;
    prefixedName: string;
    matchedBy: 'uuid';
  };

  type PlayerSelectorRow = {
    playerId: string;
    playerName: string;
    displayLabel: string;
    teamColor: string | null;
  };

  type MapPlayerRow = {
    playerId: string;
    playerName: string;
    team: string;
    teamColor: string;
    town: string;
    townColor: string;
    health: string;
    armor: string;
    x: number;
    z: number;
  };

  const tabPlayerIndexById = new Map<string, TabPlayerInfo>();
  const playerSelectorRowById = new Map<string, PlayerSelectorRow>();
  const mapPlayerRowById = new Map<string, MapPlayerRow>();
  let cachedPlayerSelectorRows: PlayerSelectorRow[] | null = null;
  let cachedMapPlayerRows: Array<Omit<MapPlayerRow, 'x' | 'z'>> | null = null;

  let wsClient: ReturnType<typeof createWebMapWsClient> | null = null;

  const autoMarkSync = createAutoMarkSyncManager({
    isWsOpen: () => Boolean(wsClient?.isWsOpen()),
    sendWebMapCommand: (message) => wsClient ? wsClient.sendCommand(message) : false,
    getConfiguredTeamColor: (team) => getConfiguredTeamColor(team, CONFIG),
  });

  function getPlayerMark(playerId: string) {
    if (!latestPlayerMarks || typeof latestPlayerMarks !== 'object') return null;
    const entry = latestPlayerMarks[playerId];
    if (!entry || typeof entry !== 'object') return null;

    const team = normalizeTeam(entry.team);
    const color = normalizeColor(entry.color, getConfiguredTeamColor(team, CONFIG));
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : null;
    const sourceRaw = typeof entry.source === 'string' ? entry.source.trim().toLowerCase() : '';
    const source = normalizeMarkSource(sourceRaw);
    return { team, color, label, source };
  }

  function getAutoTeamTagsCacheKey() {
    return [
      String(Boolean(CONFIG.AUTO_TEAM_FROM_NAME)),
      String(CONFIG.FRIENDLY_TAGS || ''),
      String(CONFIG.ENEMY_TAGS || ''),
    ].join('\n');
  }

  function invalidateAutoTeamTagCache() {
    cachedAutoTeamTagsKey = '';
    cachedFriendlyTags = [];
    cachedEnemyTags = [];
  }

  function ensureParsedAutoTeamTags() {
    const nextKey = getAutoTeamTagsCacheKey();
    if (nextKey === cachedAutoTeamTagsKey) {
      return;
    }
    cachedAutoTeamTagsKey = nextKey;
    cachedFriendlyTags = parseTagList(CONFIG.FRIENDLY_TAGS);
    cachedEnemyTags = parseTagList(CONFIG.ENEMY_TAGS);
  }

  function autoTeamFromName(nameText: string) {
    if (!CONFIG.AUTO_TEAM_FROM_NAME) return null;
    const name = String(nameText || '');
    if (!name) return null;

    ensureParsedAutoTeamTags();

    // 优先从 displayName 中提取方括号内的城镇名（如 [喀布尔]）进行标签匹配
    const townNameMatch = name.match(/\[([^\]]+)\]/);
    if (townNameMatch) {
      const townName = townNameMatch[1];
      if (cachedFriendlyTags.some((tag) => townName.includes(tag))) {
        return {
          team: 'friendly',
          color: getConfiguredTeamColor('friendly', CONFIG),
          label: '',
        };
      }
      if (cachedEnemyTags.some((tag) => townName.includes(tag))) {
        return {
          team: 'enemy',
          color: getConfiguredTeamColor('enemy', CONFIG),
          label: '',
        };
      }
    }

    // 如果没有城镇名，则使用完整名称进行匹配（兼容旧逻辑）
    if (cachedFriendlyTags.some((tag) => name.includes(tag))) {
      return {
        team: 'friendly',
        color: getConfiguredTeamColor('friendly', CONFIG),
        label: '',
      };
    }
    if (cachedEnemyTags.some((tag) => name.includes(tag))) {
      return {
        team: 'enemy',
        color: getConfiguredTeamColor('enemy', CONFIG),
        label: '',
      };
    }
    return null;
  }

  function composeDisplayLabel(rawLabel: string, rawPlayerName: string) {
    const label = String(rawLabel || '').trim();
    const playerName = String(rawPlayerName || '').trim();
    if (!label) return playerName;
    if (!playerName) return label;
    if (label === playerName) return label;
    if (label.includes(playerName)) return label;
    return `${label} ${playerName}`;
  }

  function getSnapshotPlayers() {
    return latestSnapshot && typeof latestSnapshot === 'object' && latestSnapshot.players && typeof latestSnapshot.players === 'object'
      ? latestSnapshot.players
      : null;
  }

  function getSnapshotPlayerData(playerId: string) {
    const players = getSnapshotPlayers();
    if (!players) return null;
    return getPlayerDataNode(players[String(playerId)]) || null;
  }

  function createTabPlayerInfoFromNode(node: any): TabPlayerInfo | null {
    if (!node || typeof node !== 'object') return null;
    const playerId = String(node.uuid || node.id || '').trim();
    if (!playerId) return null;

    const prefixedName = String(node.prefixedName || '').trim();
    const displayNameRaw = String(node.displayName || '').trim();
    const name = String(node.name || '').trim();
    const parsedDisplay = parseMcDisplayName(displayNameRaw || prefixedName);
    const teamText = parsedDisplay.teamText || (prefixedName ? `[${prefixedName}]` : '');

    return {
      name,
      teamText,
      teamColor: parsedDisplay.color,
      autoName: name || parsedDisplay.plain || prefixedName || null,
      displayNameRaw,
      prefixedName,
      matchedBy: 'uuid',
    };
  }

  function mergeTabPlayerInfo(previous: TabPlayerInfo, next: TabPlayerInfo): TabPlayerInfo {
    return {
      name: previous.name || next.name,
      teamText: previous.teamText || next.teamText,
      teamColor: previous.teamColor || next.teamColor,
      autoName: previous.autoName || next.autoName,
      displayNameRaw: previous.displayNameRaw || next.displayNameRaw,
      prefixedName: previous.prefixedName || next.prefixedName,
      matchedBy: 'uuid',
    };
  }

  function rebuildTabPlayerIndex() {
    tabPlayerIndexById.clear();
    const tabState = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.tabState : null;
    const reports = tabState && typeof tabState.reports === 'object' ? tabState.reports : null;
    if (!reports) return;

    for (const report of Object.values(reports)) {
      if (!report || typeof report !== 'object') continue;
      const players = Array.isArray(report.players) ? report.players : [];
      for (const node of players) {
        const nextInfo = createTabPlayerInfoFromNode(node);
        if (!nextInfo) continue;
        const playerId = String(node.uuid || node.id || '').trim();
        const previous = tabPlayerIndexById.get(playerId);
        tabPlayerIndexById.set(playerId, previous ? mergeTabPlayerInfo(previous, nextInfo) : nextInfo);
      }
    }
  }

  function getTabPlayerInfo(playerId: string) {
    return tabPlayerIndexById.get(String(playerId || '').trim()) || null;
  }

  function getTabPlayerName(playerId: string) {
    const info = getTabPlayerInfo(playerId);
    return info ? info.autoName : null;
  }

  function getTabOnlinePlayerCount() {
    return tabPlayerIndexById.size;
  }

  function getSnapshotScopeCounts(snapshot: Record<string, any> | null) {
    return {
      playersInSnapshot: snapshot && typeof snapshot.players === 'object' ? Object.keys(snapshot.players).length : 0,
      entitiesInSnapshot: snapshot && typeof snapshot.entities === 'object' ? Object.keys(snapshot.entities).length : 0,
      waypointsInSnapshot: snapshot && typeof snapshot.waypoints === 'object' ? Object.keys(snapshot.waypoints).length : 0,
      battleChunksInSnapshot: snapshot && typeof snapshot.battleChunks === 'object' ? Object.keys(snapshot.battleChunks).length : 0,
      tabReports: snapshot && snapshot.tabState && typeof snapshot.tabState.reports === 'object'
        ? Object.keys(snapshot.tabState.reports).length
        : 0,
      connections: snapshot && Array.isArray(snapshot.connections) ? snapshot.connections.length : 0,
    };
  }

  function getDimensionStats(snapshot: Record<string, any> | null, targetDimension: string) {
    const wantedDim = normalizeDimension(targetDimension);
    const buckets = new Map<string, {
      dimension: string;
      total: number;
      players: number;
      entities: number;
      waypoints: number;
      battleChunks: number;
      matchesTarget: boolean;
    }>();
    let totalWithDimension = 0;
    let matchingTarget = 0;
    let missingDimension = 0;

    const consumeScope = (
      scope: Record<string, any> | null | undefined,
      scopeName: 'players' | 'entities' | 'waypoints' | 'battleChunks',
    ) => {
      if (!scope || typeof scope !== 'object') return;
      for (const rawNode of Object.values(scope)) {
        const data = getPlayerDataNode(rawNode);
        if (!data) continue;
        const dim = normalizeDimension(data.dimension);
        if (!dim) {
          missingDimension += 1;
          continue;
        }
        totalWithDimension += 1;
        const matchesTarget = !wantedDim || dim === wantedDim;
        if (matchesTarget) {
          matchingTarget += 1;
        }
        const existing = buckets.get(dim) || {
          dimension: dim,
          total: 0,
          players: 0,
          entities: 0,
          waypoints: 0,
          battleChunks: 0,
          matchesTarget,
        };
        existing.total += 1;
        existing[scopeName] += 1;
        existing.matchesTarget = existing.matchesTarget || matchesTarget;
        buckets.set(dim, existing);
      }
    };

    consumeScope(snapshot?.players, 'players');
    consumeScope(snapshot?.entities, 'entities');
    consumeScope(snapshot?.waypoints, 'waypoints');
    consumeScope(snapshot?.battleChunks, 'battleChunks');

    const dimensions = Array.from(buckets.values()).sort((a, b) => {
      if (a.matchesTarget !== b.matchesTarget) {
        return a.matchesTarget ? -1 : 1;
      }
      if (a.total !== b.total) {
        return b.total - a.total;
      }
      return a.dimension.localeCompare(b.dimension);
    });

    return {
      targetDimension: wantedDim,
      totalWithDimension,
      matchingTarget,
      hiddenByDimension: Math.max(0, totalWithDimension - matchingTarget),
      missingDimension,
      dimensions,
      hiddenDimensions: dimensions.filter((item) => !item.matchesTarget),
    };
  }

  function getOverviewDimensionOptions(snapshot: Record<string, any> | null, targetDimension: string) {
    const normalizedTarget = normalizeDimension(targetDimension) || DEFAULT_CONFIG.TARGET_DIMENSION;
    const stats = getDimensionStats(snapshot, normalizedTarget);
    const ordered: string[] = [];
    const seen = new Set<string>();

    const append = (dimension: unknown) => {
      const normalized = normalizeDimension(dimension);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      ordered.push(normalized);
    };

    append(DEFAULT_CONFIG.TARGET_DIMENSION);
    append(normalizedTarget);
    for (const item of stats.dimensions) {
      append(item.dimension);
    }

    return ordered;
  }

  function isDebugPanelEnabled() {
    return Boolean(CONFIG.DEBUG_PANEL_ENABLED);
  }

  function updateDimensionOptionsCache() {
    cachedDimensionOptions = getOverviewDimensionOptions(
      latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot : null,
      CONFIG.TARGET_DIMENSION,
    );
  }

  function createDisabledDebugState() {
    return {
      diagnosis: [],
      summary: {
        wsConnected,
        wsReadyState: Number.isFinite(wsClient?.getStatus?.().wsReadyState) ? Number(wsClient?.getStatus?.().wsReadyState) : -1,
        lastErrorText,
        lastInboundType: '-',
        lastInboundAt: 0,
        serverProtocolVersion: serverProtocolVersion || '-',
        roomCode: CONFIG.ROOM_CODE,
        targetDimension: CONFIG.TARGET_DIMENSION,
        onlinePlayersFromTab: 0,
        tabReports: 0,
        playersInSnapshot: 0,
        entitiesInSnapshot: 0,
        waypointsInSnapshot: 0,
        battleChunksInSnapshot: 0,
        connections: 0,
        mapReady: false,
        hasLeafletRef: false,
        hasCapturedMap: false,
        mapContainerConnected: false,
        interactionPaused: false,
        interactionReplayDroppedCount: 0,
        lastDecodeMs: 0,
        lastMergeMs: 0,
        lastOverlayApplyMs: 0,
        lastOverlayApplyMode: 'idle',
        lastUiRefreshMs: lastUiRefreshDurationMs,
        lastPlayerDeriveMs,
        lastPlayerUiFlushMs,
        tabIndexedPlayers: tabPlayerIndexById.size,
        playerSelectorDirty,
        mapPlayerListDirty,
        markersOnMap: 0,
        waypointsOnMap: 0,
        battleChunksOnMap: 0,
        markerPositionOnlyUpdates: 0,
        markerVisualUpdates: 0,
        markerRecreates: 0,
        waypointPositionOnlyUpdates: 0,
        waypointVisualUpdates: 0,
        waypointRecreates: 0,
        battleChunkGeometryUpdates: 0,
        battleChunkVisualUpdates: 0,
        battleChunkRecreates: 0,
      },
      json: {
        lastInboundMessage: null,
        lastSnapshotFull: null,
        lastPatch: null,
        latestSnapshot: null,
      },
      dimensionFilter: {
        targetDimension: CONFIG.TARGET_DIMENSION,
        totalWithDimension: 0,
        matchingTarget: 0,
        hiddenByDimension: 0,
        missingDimension: 0,
        dimensions: [],
        hiddenDimensions: [],
      },
      history: [],
      lastResyncRequest: null,
      lastCloseEvent: null,
      lastRuntimeError: null,
    };
  }

  function samePlayerSelectorRow(left: PlayerSelectorRow | null | undefined, right: PlayerSelectorRow | null | undefined) {
    return Boolean(left) && Boolean(right) &&
      left!.playerId === right!.playerId &&
      left!.playerName === right!.playerName &&
      left!.displayLabel === right!.displayLabel &&
      left!.teamColor === right!.teamColor;
  }

  function sameMapPlayerRow(left: MapPlayerRow | null | undefined, right: MapPlayerRow | null | undefined) {
    return Boolean(left) && Boolean(right) &&
      left!.playerId === right!.playerId &&
      left!.playerName === right!.playerName &&
      left!.team === right!.team &&
      left!.teamColor === right!.teamColor &&
      left!.town === right!.town &&
      left!.townColor === right!.townColor &&
      left!.health === right!.health &&
      left!.armor === right!.armor &&
      left!.x === right!.x &&
      left!.z === right!.z;
  }

  function sameMapPlayerRowDisplay(left: MapPlayerRow | null | undefined, right: MapPlayerRow | null | undefined) {
    return Boolean(left) && Boolean(right) &&
      left!.playerId === right!.playerId &&
      left!.playerName === right!.playerName &&
      left!.team === right!.team &&
      left!.teamColor === right!.teamColor &&
      left!.town === right!.town &&
      left!.townColor === right!.townColor &&
      left!.health === right!.health &&
      left!.armor === right!.armor;
  }

  function invalidatePlayerSelectorRows() {
    playerSelectorDirty = true;
    cachedPlayerSelectorRows = null;
  }

  function invalidateMapPlayerListRows() {
    mapPlayerListDirty = true;
    cachedMapPlayerRows = null;
  }

  function getCanonicalPlayerName(playerId: string, tabInfo: TabPlayerInfo | null, playerData: Record<string, any> | null) {
    const fallbackName = String(
      (playerData && (playerData.playerName || playerData.playerUUID || playerData.name)) || playerId || '',
    ).trim();
    return String(tabInfo?.name || tabInfo?.autoName || fallbackName || playerId).trim() || String(playerId);
  }

  function buildPlayerSelectorRow(playerId: string): PlayerSelectorRow | null {
    const normalizedId = String(playerId || '').trim();
    if (!normalizedId) return null;
    const tabInfo = getTabPlayerInfo(normalizedId);
    const playerData = getSnapshotPlayerData(normalizedId);
    if (!tabInfo && !playerData) {
      return null;
    }

    const playerName = getCanonicalPlayerName(normalizedId, tabInfo, playerData);
    const displayLabel = composeDisplayLabel(tabInfo?.teamText || '', playerName);
    return {
      playerId: normalizedId,
      playerName,
      displayLabel: displayLabel || playerName || normalizedId,
      teamColor: tabInfo?.teamColor || null,
    };
  }

  function buildMapPlayerRow(playerId: string): MapPlayerRow | null {
    const normalizedId = String(playerId || '').trim();
    if (!normalizedId) return null;
    const data = getSnapshotPlayerData(normalizedId);
    if (!data) return null;

    const wantedDim = normalizeDimension(CONFIG.TARGET_DIMENSION);
    const dim = normalizeDimension(data.dimension);
    if (wantedDim && dim !== wantedDim) return null;

    const x = readNumber(data.x);
    const z = readNumber(data.z);
    if (x === null || z === null) return null;

    const tabInfo = getTabPlayerInfo(normalizedId);
    const playerName = getCanonicalPlayerName(normalizedId, tabInfo, data);
    const displayNameForAutoMark = tabInfo?.teamText ? `${tabInfo.teamText} ${playerName}` : playerName;
    const existingMark = getPlayerMark(normalizedId);
    const autoMark = autoTeamFromName(displayNameForAutoMark);
    const existingMarkSource = existingMark ? normalizeMarkSource(existingMark.source) : 'manual';
    const existingActsAsAuto = Boolean(existingMark) && existingMarkSource === 'auto';
    const isManualMark = Boolean(existingMark) && !existingActsAsAuto;
    const effectiveMark = isManualMark
      ? existingMark
      : (autoMark || (existingActsAsAuto ? null : existingMark));
    const team = normalizeTeam(effectiveMark?.team || 'neutral');
    const teamLabelMap: Record<string, string> = {
      friendly: '友军',
      enemy: '敌军',
      neutral: '中立',
    };
    const teamColor = normalizeColor(effectiveMark?.color, getConfiguredTeamColor(team, CONFIG));
    const townColor = normalizeColor(tabInfo?.teamColor, '#93c5fd');
    const health = readNumber(data.health);
    const armor = readNumber(data.armor);

    return {
      playerId: normalizedId,
      playerName,
      team: teamLabelMap[team] || teamLabelMap.neutral,
      teamColor,
      town: String(tabInfo?.teamText || '').trim() || '-',
      townColor,
      health: health === null ? '-' : String(Math.round(health)),
      armor: armor === null ? '-' : String(Math.round(armor)),
      x,
      z,
    };
  }

  function upsertPlayerSelectorRow(playerId: string) {
    const normalizedId = String(playerId || '').trim();
    if (!normalizedId) return;
    const previous = playerSelectorRowById.get(normalizedId) || null;
    const next = buildPlayerSelectorRow(normalizedId);
    if (!next) {
      if (!previous) return;
      playerSelectorRowById.delete(normalizedId);
      onlinePlayerCount = playerSelectorRowById.size;
      invalidatePlayerSelectorRows();
      return;
    }
    if (samePlayerSelectorRow(previous, next)) {
      return;
    }
    playerSelectorRowById.set(normalizedId, next);
    onlinePlayerCount = playerSelectorRowById.size;
    invalidatePlayerSelectorRows();
  }

  function upsertMapPlayerRow(playerId: string) {
    const normalizedId = String(playerId || '').trim();
    if (!normalizedId) return;
    const previous = mapPlayerRowById.get(normalizedId) || null;
    const next = buildMapPlayerRow(normalizedId);
    if (!next) {
      if (!previous) return;
      mapPlayerRowById.delete(normalizedId);
      visibleMapPlayerCount = mapPlayerRowById.size;
      invalidateMapPlayerListRows();
      return;
    }
    if (sameMapPlayerRow(previous, next)) {
      return;
    }
    mapPlayerRowById.set(normalizedId, next);
    visibleMapPlayerCount = mapPlayerRowById.size;
    if (!sameMapPlayerRowDisplay(previous, next)) {
      invalidateMapPlayerListRows();
    }
  }

  function rebuildPlayerSelectorRows() {
    playerSelectorRowById.clear();
    const nextIds = new Set<string>(tabPlayerIndexById.keys());
    const snapshotPlayers = getSnapshotPlayers();
    if (snapshotPlayers) {
      for (const playerId of Object.keys(snapshotPlayers)) {
        nextIds.add(String(playerId));
      }
    }
    for (const playerId of nextIds) {
      const nextRow = buildPlayerSelectorRow(playerId);
      if (nextRow) {
        playerSelectorRowById.set(String(playerId), nextRow);
      }
    }
    onlinePlayerCount = playerSelectorRowById.size;
    invalidatePlayerSelectorRows();
  }

  function rebuildMapPlayerRows() {
    mapPlayerRowById.clear();
    const snapshotPlayers = getSnapshotPlayers();
    if (snapshotPlayers) {
      for (const playerId of Object.keys(snapshotPlayers)) {
        const nextRow = buildMapPlayerRow(playerId);
        if (nextRow) {
          mapPlayerRowById.set(String(playerId), nextRow);
        }
      }
    }
    visibleMapPlayerCount = mapPlayerRowById.size;
    invalidateMapPlayerListRows();
  }

  function rebuildAllDerivedPlayerCaches() {
    rebuildPlayerSelectorRows();
    rebuildMapPlayerRows();
  }

  function materializePlayerSelectorRows() {
    if (!playerSelectorDirty && cachedPlayerSelectorRows) {
      return cachedPlayerSelectorRows;
    }
    const nextRows = Array.from(playerSelectorRowById.values()).sort((left, right) => {
      const leftText = String(left.displayLabel || left.playerName || left.playerId || '');
      const rightText = String(right.displayLabel || right.playerName || right.playerId || '');
      return leftText.localeCompare(rightText, 'zh-Hans-CN');
    });
    cachedPlayerSelectorRows = nextRows;
    playerSelectorDirty = false;
    return nextRows;
  }

  function materializeMapPlayerRows() {
    if (!mapPlayerListDirty && cachedMapPlayerRows) {
      return cachedMapPlayerRows;
    }
    const nextRows = Array.from(mapPlayerRowById.values())
      .sort((left, right) => left.playerName.localeCompare(right.playerName, 'zh-Hans-CN'))
      .map(({ x, z, ...row }) => row);
    cachedMapPlayerRows = nextRows;
    mapPlayerListDirty = false;
    return nextRows;
  }

  function shouldFlushPlayerSelectorUi() {
    return settingsUi.isPanelVisible() && settingsUi.getCurrentPage() === 'mark';
  }

  function shouldFlushMapPlayerListUi() {
    return settingsUi.isPlayerListVisible();
  }

  function flushVisiblePlayerUi(options: { forceSelector?: boolean; forceMapPlayerList?: boolean } = {}) {
    const shouldFlushSelector = Boolean(options.forceSelector) || shouldFlushPlayerSelectorUi();
    const shouldFlushMapPlayerList = Boolean(options.forceMapPlayerList) || shouldFlushMapPlayerListUi();
    if (!shouldFlushSelector && !shouldFlushMapPlayerList) {
      return;
    }

    const flushStartedAt = performance.now();
    let flushed = false;
    if (shouldFlushSelector && (options.forceSelector || playerSelectorDirty)) {
      settingsUi.refreshPlayerSelector(materializePlayerSelectorRows());
      flushed = true;
    }
    if (shouldFlushMapPlayerList && (options.forceMapPlayerList || mapPlayerListDirty)) {
      settingsUi.refreshMapPlayerList(materializeMapPlayerRows());
      flushed = true;
    }
    if (flushed) {
      lastPlayerUiFlushMs = Math.max(0, performance.now() - flushStartedAt);
    }
  }

  function syncDerivedPlayersForChange(changeSet: SnapshotChangeSet | null) {
    const deriveStartedAt = performance.now();
    if (!changeSet || changeSet.kind === 'full') {
      rebuildTabPlayerIndex();
      rebuildAllDerivedPlayerCaches();
      lastPlayerDeriveMs = Math.max(0, performance.now() - deriveStartedAt);
      return;
    }

    if (changeSet.dirtyScopes.tabState) {
      rebuildTabPlayerIndex();
      rebuildAllDerivedPlayerCaches();
      lastPlayerDeriveMs = Math.max(0, performance.now() - deriveStartedAt);
      return;
    }

    if (changeSet.dirtyScopes.players) {
      for (const playerId of changeSet.deleteIds.players) {
        upsertPlayerSelectorRow(String(playerId));
        upsertMapPlayerRow(String(playerId));
      }
      for (const playerId of changeSet.upsertIds.players) {
        upsertPlayerSelectorRow(String(playerId));
        upsertMapPlayerRow(String(playerId));
      }
    }

    if (changeSet.dirtyScopes.playerMarks) {
      for (const playerId of changeSet.deleteIds.playerMarks) {
        upsertMapPlayerRow(String(playerId));
      }
      for (const playerId of changeSet.upsertIds.playerMarks) {
        upsertMapPlayerRow(String(playerId));
      }
    }

    onlinePlayerCount = playerSelectorRowById.size;
    visibleMapPlayerCount = mapPlayerRowById.size;
    lastPlayerDeriveMs = Math.max(0, performance.now() - deriveStartedAt);
  }

  const mapProjection = createMapProjection({
    page: PAGE,
    config: CONFIG,
    overlayStyleText: OVERLAY_STYLE_TEXT,
    getPlayerMark,
    getTabPlayerInfo,
    getTabPlayerName,
    autoTeamFromName,
    getConfiguredTeamColor: (team) => getConfiguredTeamColor(team, CONFIG),
    maybeSyncAutoDetectedMarks: autoMarkSync.maybeSyncAutoDetectedMarks,
    getLatestPlayerMarks: () => latestPlayerMarks,
    getWsConnected: () => wsConnected,
    isDebugEnabled: () => isDebugPanelEnabled(),
    onCreateTacticalWaypoint: (payload) => {
      const ok = sendWebMapCommand(buildCommandTacticalWaypointSet({
        x: payload.x,
        z: payload.z,
        label: payload.label,
        tacticalType: payload.tacticalType,
        color: payload.color,
        ttlSeconds: payload.ttlSeconds,
        permanent: payload.permanent,
        roomCode: CONFIG.ROOM_CODE,
        dimension: CONFIG.TARGET_DIMENSION,
      }));
      if (ok) {
        lastErrorText = null;
        updateUiStatus();
      }
      return ok;
    },
    onDeleteTacticalWaypoint: ({ waypointId }) => {
      const ok = sendWebMapCommand(buildCommandTacticalWaypointDelete(waypointId));
      if (ok) {
        lastErrorText = null;
        updateUiStatus();
      }
      return ok;
    },
    onDebugStateChanged: () => {
      scheduleUiStatusUpdate({ recomputeDebug: isDebugPanelEnabled(), delayMs: 260 });
    },
  });

  function loadConfigFromStorage() {
    try {
      const raw = PAGE.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const normalized = sanitizeConfig(parsed);
      Object.assign(CONFIG, normalized);
    } catch (error) {
      console.warn('[TeamViewRelay Overlay] load settings failed:', error);
    }
  }

  function saveConfigToStorage() {
    try {
      PAGE.localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
    } catch (error) {
      console.warn('[TeamViewRelay Overlay] save settings failed:', error);
    }
  }

  function downloadTextFile(fileName: string, text: string) {
    try {
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      return true;
    } catch (error) {
      console.warn('[TeamViewRelay Overlay] export config failed:', error);
      return false;
    }
  }

  function exportConfig() {
    const payload = createConfigExportPayload(CONFIG);
    const fileName = buildExportFileName();
    const ok = downloadTextFile(fileName, JSON.stringify(payload, null, 2));
    if (!ok) {
      lastErrorText = '配置导出失败，请查看控制台日志';
      updateUiStatus();
      return;
    }
    lastErrorText = null;
    const compat = getConfigCompatVersion();
    settingsUi.updateStatus(`状态: 配置已导出（兼容版本 ${compat}）`);
  }

  function importConfigFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';

    const cleanupInput = () => {
      try {
        input.remove();
      } catch (_) {}
    };

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      if (!file) {
        cleanupInput();
        return;
      }

      try {
        const text = await file.text();
        const parsed = parseImportedConfigText(text);
        if (!parsed.ok || !parsed.config) {
          lastErrorText = parsed.error || '配置导入失败';
          updateUiStatus();
          return;
        }

        Object.assign(CONFIG, parsed.config);
        saveConfigToStorage();
        settingsUi.fillFormFromConfig(CONFIG, (team) => getConfiguredTeamColor(team, CONFIG));
        rebuildDerivedPlayersForCurrentState();
        mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
        wsClient?.reconnect();
        flushVisiblePlayerUi({
          forceSelector: settingsUi.isPanelVisible() && settingsUi.getCurrentPage() === 'mark',
          forceMapPlayerList: settingsUi.isPlayerListVisible(),
        });
        lastErrorText = null;
        updateUiStatus();
      } catch (error) {
        console.warn('[TeamViewRelay Overlay] import config failed:', error);
        lastErrorText = '配置导入失败：读取文件异常';
        updateUiStatus();
      } finally {
        cleanupInput();
      }
    });

    document.body.appendChild(input);
    input.click();
  }

  function updateOverviewStatus(options: { includeDimensionOptions?: boolean } = {}) {
    const mapCounts = mapProjection.getCounts();
    const annotations = mapCounts.markers + mapCounts.waypoints;
    const overviewPatch: Record<string, any> = {
      wsConnected,
      hasError: Boolean(lastErrorText),
      markerCount: annotations,
      battleChunkCount: mapCounts.battleChunks,
      onlinePlayerCount,
      mapPlayerCount: visibleMapPlayerCount,
      roomCode: CONFIG.ROOM_CODE,
      targetDimension: CONFIG.TARGET_DIMENSION,
      clientProtocolVersion: ADMIN_NETWORK_PROTOCOL_VERSION,
      serverProtocolVersion: serverProtocolVersion || '-',
    };
    if (options.includeDimensionOptions) {
      overviewPatch.dimensionOptions = cachedDimensionOptions;
    }
    settingsUi.updateStatus(lastErrorText ? `错误: ${lastErrorText}` : '', overviewPatch);
  }

  function updateUiStatus(options: { recomputeDimensionOptions?: boolean; recomputeDebug?: boolean } = {}) {
    const startedAt = performance.now();
    if (options.recomputeDimensionOptions !== false) {
      updateDimensionOptionsCache();
    }
    updateOverviewStatus({
      includeDimensionOptions: options.recomputeDimensionOptions !== false,
    });
    const shouldRecomputeDebug = options.recomputeDebug !== false;
    if (shouldRecomputeDebug || !isDebugPanelEnabled()) {
      settingsUi.updateDebug(
        isDebugPanelEnabled()
          ? buildOverlayDebugState()
          : createDisabledDebugState(),
      );
    }
    lastUiRefreshDurationMs = Math.max(0, performance.now() - startedAt);
  }

  function scheduleUiStatusUpdate(options: { recomputeDimensionOptions?: boolean; recomputeDebug?: boolean; delayMs?: number } = {}) {
    pendingUiDimensionRefresh = pendingUiDimensionRefresh || Boolean(options.recomputeDimensionOptions);
    pendingUiDebugRefresh = pendingUiDebugRefresh || Boolean(options.recomputeDebug);
    if (uiStatusTimer !== null) {
      return;
    }
    uiStatusTimer = setTimeout(() => {
      uiStatusTimer = null;
      const nextDimensionRefresh = pendingUiDimensionRefresh;
      const nextDebugRefresh = pendingUiDebugRefresh;
      pendingUiDimensionRefresh = false;
      pendingUiDebugRefresh = false;
      updateUiStatus({
        recomputeDimensionOptions: nextDimensionRefresh,
        recomputeDebug: nextDebugRefresh,
      });
    }, Number.isFinite(options.delayMs) ? Math.max(0, Number(options.delayMs)) : 240);
  }

  function buildOverlayDebugState() {
    if (!isDebugPanelEnabled()) {
      return createDisabledDebugState();
    }
    const snapshot = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot : null;
    const wsStatus = wsClient?.getStatus() || {};
    const wsDebug = wsClient?.getDebugState?.() || {};
    const mapDebug = mapProjection.getDebugState();
    const scopeCounts = getSnapshotScopeCounts(snapshot);
    const onlinePlayersFromTab = getTabOnlinePlayerCount();
    const renderedObjects = mapDebug.markers + mapDebug.waypoints + mapDebug.battleChunks;
    const dimensionStats = getDimensionStats(snapshot, CONFIG.TARGET_DIMENSION);
    const totalSnapshotObjects =
      scopeCounts.playersInSnapshot +
      scopeCounts.entitiesInSnapshot +
      scopeCounts.waypointsInSnapshot +
      scopeCounts.battleChunksInSnapshot;
    const diagnosis: string[] = [];

    if ((onlinePlayersFromTab > 0 || scopeCounts.tabReports > 0) && totalSnapshotObjects <= 0) {
      diagnosis.push('当前只收到了 TAB/在线列表相关数据，地图对象数据尚未进入本地快照。');
    }

    if (totalSnapshotObjects > 0 && !mapDebug.mapReady) {
      diagnosis.push('本地已收到对象数据，但地图尚未就绪或尚未完成重放。');
    } else if (
      totalSnapshotObjects > 0 &&
      mapDebug.mapReady &&
      renderedObjects <= 0 &&
      dimensionStats.totalWithDimension > 0 &&
      dimensionStats.matchingTarget <= 0
    ) {
      const hiddenDimensionText = dimensionStats.hiddenDimensions.length
        ? dimensionStats.hiddenDimensions.map((item) => item.dimension).join('、')
        : '未知维度';
      diagnosis.push(`本地有对象，但被维度过滤隐藏。目标维度：${dimensionStats.targetDimension || '未设置'}；当前对象维度：${hiddenDimensionText}。`);
    } else if (totalSnapshotObjects > 0 && mapDebug.mapReady && renderedObjects <= 0) {
      diagnosis.push('本地已收到对象数据，但地图当前没有渲染出任何对象，请优先检查地图捕获和对象字段。');
    }

    return {
      diagnosis,
      summary: {
        wsConnected,
        wsReadyState: Number.isFinite(wsStatus.wsReadyState) ? wsStatus.wsReadyState : -1,
        lastErrorText,
        lastInboundType: String(wsDebug?.lastInbound?.type || lastWebMapMessageType || '-'),
        lastInboundAt: Number(wsDebug?.lastInbound?.receivedAt || lastWebMapMessageAt || 0),
        serverProtocolVersion: serverProtocolVersion || '-',
        roomCode: CONFIG.ROOM_CODE,
        targetDimension: CONFIG.TARGET_DIMENSION,
        onlinePlayersFromTab,
        tabReports: scopeCounts.tabReports,
        playersInSnapshot: scopeCounts.playersInSnapshot,
        entitiesInSnapshot: scopeCounts.entitiesInSnapshot,
        waypointsInSnapshot: scopeCounts.waypointsInSnapshot,
        battleChunksInSnapshot: scopeCounts.battleChunksInSnapshot,
        connections: scopeCounts.connections,
        mapReady: Boolean(mapDebug.mapReady),
        hasLeafletRef: Boolean(mapDebug.hasLeafletRef),
        hasCapturedMap: Boolean(mapDebug.hasCapturedMap),
        mapContainerConnected: Boolean(mapDebug.mapContainerConnected),
        interactionPaused: Boolean(mapDebug.interactionPaused),
        interactionReplayDroppedCount: Number(mapDebug.interactionReplayDroppedCount || 0),
        lastDecodeMs: Number(wsDebug?.lastPerf?.decodeMs || 0),
        lastMergeMs: Number(wsDebug?.lastPerf?.mergeMs || 0),
        lastOverlayApplyMs: Number(mapDebug.lastApplyDurationMs || 0),
        lastOverlayApplyMode: String(mapDebug.lastApplyMode || 'idle'),
        lastUiRefreshMs: lastUiRefreshDurationMs,
        lastPlayerDeriveMs,
        lastPlayerUiFlushMs,
        tabIndexedPlayers: tabPlayerIndexById.size,
        playerSelectorDirty,
        mapPlayerListDirty,
        markersOnMap: Number(mapDebug.markers || 0),
        waypointsOnMap: Number(mapDebug.waypoints || 0),
        battleChunksOnMap: Number(mapDebug.battleChunks || 0),
        markerPositionOnlyUpdates: Number(mapDebug.markerPositionOnlyUpdates || 0),
        markerVisualUpdates: Number(mapDebug.markerVisualUpdates || 0),
        markerRecreates: Number(mapDebug.markerRecreates || 0),
        waypointPositionOnlyUpdates: Number(mapDebug.waypointPositionOnlyUpdates || 0),
        waypointVisualUpdates: Number(mapDebug.waypointVisualUpdates || 0),
        waypointRecreates: Number(mapDebug.waypointRecreates || 0),
        battleChunkGeometryUpdates: Number(mapDebug.battleChunkGeometryUpdates || 0),
        battleChunkVisualUpdates: Number(mapDebug.battleChunkVisualUpdates || 0),
        battleChunkRecreates: Number(mapDebug.battleChunkRecreates || 0),
      },
      json: {
        lastInboundMessage: normalizeDebugJsonValue(wsDebug?.lastInbound?.payload ?? null),
        lastSnapshotFull: normalizeDebugJsonValue(wsDebug?.lastSnapshotFull?.payload ?? null),
        lastPatch: normalizeDebugJsonValue(wsDebug?.lastPatch?.payload ?? null),
        latestSnapshot: normalizeDebugJsonValue(snapshot),
      },
      dimensionFilter: {
        targetDimension: dimensionStats.targetDimension || CONFIG.TARGET_DIMENSION,
        totalWithDimension: dimensionStats.totalWithDimension,
        matchingTarget: dimensionStats.matchingTarget,
        hiddenByDimension: dimensionStats.hiddenByDimension,
        missingDimension: dimensionStats.missingDimension,
        dimensions: dimensionStats.dimensions,
        hiddenDimensions: dimensionStats.hiddenDimensions,
      },
      history: Array.isArray(wsDebug?.history)
        ? wsDebug.history.map((item: any) => ({
            receivedAt: Number(item?.receivedAt || 0),
            type: String(item?.type || 'unknown'),
            channel: String(item?.channel || 'admin'),
            counts: item?.counts && typeof item.counts === 'object' ? item.counts : {},
          }))
        : [],
      lastResyncRequest: wsDebug?.lastResyncRequest || null,
      lastCloseEvent: wsDebug?.lastCloseEvent || null,
      lastRuntimeError: wsDebug?.lastRuntimeError || null,
    };
  }

  async function copyText(text: string) {
    const content = String(text || '');
    if (!content) return false;
    try {
      if (PAGE.navigator?.clipboard?.writeText) {
        await PAGE.navigator.clipboard.writeText(content);
        return true;
      }
    } catch (_) {}

    try {
      const input = document.createElement('textarea');
      input.value = content;
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.style.top = '0';
      document.body.appendChild(input);
      input.focus();
      input.select();
      const ok = document.execCommand('copy');
      input.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  async function copyDebugJson(label: string, value: unknown) {
    const ok = await copyText(stringifyDebugJson(value));
    if (ok) {
      lastErrorText = null;
      settingsUi.updateStatus(`调试: 已复制${label}`);
    } else {
      lastErrorText = `复制${label}失败`;
    }
    updateUiStatus();
  }

  function requestDebugResync() {
    if (!isDebugPanelEnabled()) {
      return;
    }
    const ok = wsClient?.requestResync?.('manual_debug_panel');
    if (!ok) {
      const status = wsClient?.getStatus?.();
      lastErrorText = status?.lastErrorText || 'resync 请求未发送';
    } else {
      lastErrorText = null;
      settingsUi.updateStatus('调试: 已发送 resync 请求');
    }
    updateUiStatus();
  }

  function clearDebugHistory() {
    if (!isDebugPanelEnabled()) {
      return;
    }
    wsClient?.clearDebugHistory?.();
    lastErrorText = null;
    settingsUi.updateStatus('调试: 已清空本地调试历史');
    updateUiStatus();
  }

  function resolvePlayerIdFromInput() {
    const selectedPlayerId = settingsUi.getSelectedPlayerId();
    if (selectedPlayerId) {
      return { ok: true, playerId: selectedPlayerId };
    }
    return { ok: false, error: '请先从在线玩家列表选择目标玩家' };
  }

  function getPlayerDeriveConfigSignature() {
    return [
      normalizeDimension(CONFIG.TARGET_DIMENSION),
      String(Boolean(CONFIG.AUTO_TEAM_FROM_NAME)),
      String(CONFIG.FRIENDLY_TAGS || ''),
      String(CONFIG.ENEMY_TAGS || ''),
      String(CONFIG.TEAM_COLOR_FRIENDLY || ''),
      String(CONFIG.TEAM_COLOR_ENEMY || ''),
      String(CONFIG.TEAM_COLOR_NEUTRAL || ''),
    ].join('\n');
  }

  function rebuildDerivedPlayersForCurrentState() {
    const startedAt = performance.now();
    invalidateAutoTeamTagCache();
    rebuildAllDerivedPlayerCaches();
    lastPlayerDeriveMs = Math.max(0, performance.now() - startedAt);
  }

  function focusMapPlayerById(playerId: string) {
    const targetId = String(playerId || '').trim();
    if (!targetId) {
      lastErrorText = '玩家列表目标为空';
      updateUiStatus();
      return;
    }

    const target = mapPlayerRowById.get(targetId) || null;
    if (!target) {
      lastErrorText = '目标玩家当前不在地图显示列表中';
      updateUiStatus();
      return;
    }

    const ok = mapProjection.focusOnWorldPosition(target.x, target.z);
    if (!ok) {
      lastErrorText = '地图尚未就绪，无法定位到该玩家';
      updateUiStatus();
      return;
    }

    lastErrorText = null;
    updateUiStatus();
  }

  function applyFormToConfig() {
    const previousDebugPanelEnabled = isDebugPanelEnabled();
    const previousPlayerDeriveConfigSignature = getPlayerDeriveConfigSignature();
    const next = sanitizeConfig(settingsUi.readFormCandidate(CONFIG));
    Object.assign(CONFIG, next);
    if (previousDebugPanelEnabled && !isDebugPanelEnabled()) {
      wsClient?.clearDebugHistory?.();
    }
    if (previousPlayerDeriveConfigSignature !== getPlayerDeriveConfigSignature()) {
      rebuildDerivedPlayersForCurrentState();
      flushVisiblePlayerUi({
        forceSelector: settingsUi.isPanelVisible() && settingsUi.getCurrentPage() === 'mark',
        forceMapPlayerList: settingsUi.isPlayerListVisible(),
      });
    }
    saveConfigToStorage();
    mapProjection.ensureMapInteractionGuard();
    mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
    updateUiStatus();
  }

  function sendWebMapCommand(message: Record<string, unknown>) {
    if (!wsClient) return false;
    const ok = wsClient.sendCommand(message);
    if (!ok) {
      const status = wsClient.getStatus();
      lastErrorText = status.lastErrorText;
    }
    updateUiStatus();
    return ok;
  }

  function applyMarkFormToServer() {
    const markForm = settingsUi.getMarkForm();
    const resolved = resolvePlayerIdFromInput();
    if (!resolved.ok) {
      lastErrorText = resolved.error;
      updateUiStatus();
      return;
    }

    const team = normalizeTeam(markForm.team);
    const color = normalizeColor(markForm.color || getConfiguredTeamColor(team, CONFIG), getConfiguredTeamColor(team, CONFIG));
    const label = markForm.label;

    const ok = sendWebMapCommand(buildCommandPlayerMarkSet({
      playerId: resolved.playerId,
      team,
      color,
      label,
      source: 'manual',
    }));
    if (ok) {
      autoMarkSync.clearPlayerCache(resolved.playerId);
      lastErrorText = null;
      updateUiStatus();
    }
  }

  function clearMarkOnServer() {
    const resolved = resolvePlayerIdFromInput();
    if (!resolved.ok) {
      lastErrorText = resolved.error;
      updateUiStatus();
      return;
    }

    const ok = sendWebMapCommand(buildCommandPlayerMarkClear(resolved.playerId));
    if (ok) {
      autoMarkSync.clearPlayerCache(resolved.playerId);
      lastErrorText = null;
      updateUiStatus();
    }
  }

  function clearAllMarksOnServer() {
    const ok = sendWebMapCommand(buildCommandPlayerMarkClearAll());
    if (ok) {
      autoMarkSync.reset();
      lastErrorText = null;
      updateUiStatus();
    }
  }

  function setSameServerFilter(enabled: boolean) {
    const ok = sendWebMapCommand(buildCommandSameServerFilterSet(enabled));
    if (ok) {
      lastErrorText = null;
      updateUiStatus();
    }
  }

  const settingsUi = createSettingsUi({
    page: PAGE,
    uiStyleText: UI_STYLE_TEXT,
    onAutoApply: () => {
      applyFormToConfig();
    },
    onSave: () => {
      applyFormToConfig();
    },
    onSaveAdvanced: () => {
      applyFormToConfig();
      wsClient?.reconnect();
    },
    onSaveDisplay: () => {
      applyFormToConfig();
    },
    onExportConfig: () => {
      exportConfig();
    },
    onImportConfig: () => {
      importConfigFromFile();
    },
    onReset: () => {
      Object.assign(CONFIG, DEFAULT_CONFIG);
      rebuildDerivedPlayersForCurrentState();
      saveConfigToStorage();
      settingsUi.fillFormFromConfig(CONFIG, (team) => getConfiguredTeamColor(team, CONFIG));
      mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
      flushVisiblePlayerUi({
        forceSelector: settingsUi.isPanelVisible() && settingsUi.getCurrentPage() === 'mark',
        forceMapPlayerList: settingsUi.isPlayerListVisible(),
      });
      wsClient?.reconnect();
      updateUiStatus();
    },
    onRefresh: () => {
      wsClient?.reconnect();
    },
    onMarkApply: applyMarkFormToServer,
    onMarkClear: clearMarkOnServer,
    onMarkClearAll: clearAllMarksOnServer,
    onServerFilterToggle: setSameServerFilter,
    onTeamChanged: (team) => {
      settingsUi.setMarkColor(getConfiguredTeamColor(normalizeTeam(team), CONFIG));
    },
    onPlayerSelectionChanged: () => {
      lastErrorText = null;
      updateUiStatus();
    },
    onTogglePlayerList: (visible) => {
      settingsUi.setPlayerListVisible(Boolean(visible));
      flushVisiblePlayerUi({
        forceMapPlayerList: settingsUi.isPlayerListVisible(),
      });
      lastErrorText = null;
      updateOverviewStatus();
    },
    onFocusMapPlayer: (playerId) => {
      focusMapPlayerById(playerId);
    },
    onOverviewDimensionChanged: (dimension) => {
      const nextDimension = normalizeDimension(dimension) || DEFAULT_CONFIG.TARGET_DIMENSION;
      CONFIG.TARGET_DIMENSION = nextDimension;
      settingsUi.setTargetDimension(nextDimension);
      rebuildDerivedPlayersForCurrentState();
      mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
      flushVisiblePlayerUi({
        forceSelector: settingsUi.isPanelVisible() && settingsUi.getCurrentPage() === 'mark',
        forceMapPlayerList: settingsUi.isPlayerListVisible(),
      });
      lastErrorText = null;
      updateUiStatus();
    },
    onDebugRequestResync: () => {
      requestDebugResync();
    },
    onDebugCopySnapshot: () => {
      void copyDebugJson('当前快照 JSON', buildOverlayDebugState().json.latestSnapshot);
    },
    onDebugCopyLastMessage: () => {
      void copyDebugJson('最近消息 JSON', buildOverlayDebugState().json.lastInboundMessage);
    },
    onDebugClearHistory: () => {
      clearDebugHistory();
    },
    onPageChanged: (page) => {
      if (page === 'mark') {
        flushVisiblePlayerUi({ forceSelector: settingsUi.isPanelVisible() });
        return;
      }
      if (page === 'main' && settingsUi.isPlayerListVisible()) {
        flushVisiblePlayerUi({ forceMapPlayerList: true });
      }
    },
    onPanelVisibilityChanged: (visible) => {
      if (!visible) return;
      flushVisiblePlayerUi({
        forceSelector: settingsUi.getCurrentPage() === 'mark',
        forceMapPlayerList: settingsUi.isPlayerListVisible(),
      });
    },
  });

  function installDebugConsoleApi() {
    const debugApi = {
      help() {
        const commands = {
          help: '显示可用命令',
          summary: '查看连接状态/对象数量/最近消息',
          snapshot: '输出精简版最新内存快照',
          snapshotVerbose: '输出详细版最新内存快照（保留 $typeName）',
          playerTab: '按玩家ID查看 tab 匹配与城镇解析结果',
          markers: '输出当前地图 marker 统计',
          ws: '输出 websocket 状态',
          last: '输出精简版最近一条 ws 消息',
          lastVerbose: '输出详细版最近一条 ws 消息（保留 $typeName）',
          resync: '手动发送 resync_req 请求全量',
          ping: '手动发送 ping',
        };
        console.table(commands);
        return commands;
      },
      summary() {
        if (!isDebugPanelEnabled()) {
          return {
            debugPanelEnabled: false,
            message: '调试面板未启用',
          };
        }
        const debugState = buildOverlayDebugState();
        return {
          ...debugState.summary,
          sameServerFilterEnabled,
          diagnosis: debugState.diagnosis,
        };
      },
      snapshot() {
        if (!isDebugPanelEnabled()) {
          return null;
        }
        return buildOverlayDebugState().json.latestSnapshot;
      },
      snapshotVerbose() {
        if (!isDebugPanelEnabled()) {
          return null;
        }
        return normalizeDebugJsonValue(latestSnapshot, {
          omitUndefined: false,
          includeTypeName: true,
        });
      },
      playerTab(playerId) {
        const normalizedId = String(playerId || '').trim();
        const playerNode = normalizedId && latestSnapshot && typeof latestSnapshot.players === 'object'
          ? latestSnapshot.players[normalizedId]
          : null;
        const playerData = getPlayerDataNode(playerNode);
        const tabInfo = normalizedId ? getTabPlayerInfo(normalizedId) : null;
        return {
          playerId: normalizedId,
          playerData,
          tabInfo,
          renderedTownText: tabInfo && typeof tabInfo.teamText === 'string' ? tabInfo.teamText : '',
          showPlayerText: Boolean(CONFIG.SHOW_PLAYER_TEXT),
          showTownInfo: Boolean(CONFIG.SHOW_LABEL_TOWN_INFO),
        };
      },
      markers() {
        if (!isDebugPanelEnabled()) {
          return { debugPanelEnabled: false };
        }
        return buildOverlayDebugState().summary;
      },
      ws() {
        if (!isDebugPanelEnabled()) {
          return { debugPanelEnabled: false };
        }
        return buildOverlayDebugState().summary;
      },
      last() {
        if (!isDebugPanelEnabled()) {
          return null;
        }
        return buildOverlayDebugState().json.lastInboundMessage;
      },
      lastVerbose() {
        if (!isDebugPanelEnabled()) {
          return null;
        }
        return normalizeDebugJsonValue(wsClient?.getDebugState?.()?.lastInbound?.payload ?? null, {
          omitUndefined: false,
          includeTypeName: true,
        });
      },
      resync(reason = 'manual_console_debug') {
        const requested = wsClient?.requestResync?.(reason);
        updateUiStatus();
        return { requested: Boolean(requested), reason };
      },
      ping() {
        if (!wsClient?.isWsOpen()) {
          return { sent: false, reason: 'ws_not_open' };
        }
        wsClient.sendCommand({ type: 'ping', from: 'console_debug' });
        return { sent: true };
      },
    };

    PAGE.__TEAM_VIEW_RELAY_OVERLAY_DEBUG__ = debugApi;
    PAGE.teamViewRelayDebug = debugApi;
    PAGE.__NODEMC_OVERLAY_DEBUG__ = debugApi;
    PAGE.nodemcDebug = debugApi;
  }

  function cleanupAll() {
    pageUnloading = true;
    try {
      if (overlayStartTimer !== null) {
        clearTimeout(overlayStartTimer);
        overlayStartTimer = null;
      }
      if (uiSyncTimer !== null) {
        clearTimeout(uiSyncTimer);
        uiSyncTimer = null;
      }
      if (uiStatusTimer !== null) {
        clearTimeout(uiStatusTimer);
        uiStatusTimer = null;
      }
      if (startupObserver) {
        startupObserver.disconnect();
        startupObserver = null;
      }
      mapProjection.cleanup();
      settingsUi.cleanup();
      wsClient?.prepareForPageUnload?.();
      autoMarkSync.reset();

      try { const s2 = document.getElementById('nodemc-projection-style'); if (s2) s2.remove(); } catch (_) {}

      try { delete PAGE.__TEAM_VIEW_RELAY_OVERLAY_DEBUG__; } catch (_) {}
      try { delete PAGE.teamViewRelayDebug; } catch (_) {}
      try { delete PAGE.__NODEMC_OVERLAY_DEBUG__; } catch (_) {}
      try { delete PAGE.__TEAM_VIEW_RELAY_OVERLAY__; } catch (_) {}
      try { delete PAGE.__NODEMC_PLAYER_OVERLAY__; } catch (_) {}

      overlayStarted = false;
      deferredBootStarted = false;
      pendingUiDimensionRefresh = false;
      pendingUiDebugRefresh = false;
    } catch (_) {}
  }

  try { window.addEventListener('beforeunload', cleanupAll); } catch (_) {}

  function initOverlay() {
    mapProjection.ensureOverlayStyles();
    mapProjection.ensureMapInteractionGuard();
    mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
    updateUiStatus({ recomputeDimensionOptions: true, recomputeDebug: true });
  }

  function stopStartupObserver() {
    if (!startupObserver) return;
    startupObserver.disconnect();
    startupObserver = null;
  }

  function scheduleUiSync(attempt = 0) {
    if (pageUnloading || uiSyncTimer !== null) return;
    const delay = attempt <= 0 ? 0 : (attempt < 20 ? 50 : 200);
    uiSyncTimer = setTimeout(() => {
      uiSyncTimer = null;
      if (pageUnloading) return;
      if (!settingsUi.isMounted()) {
        if (attempt < 120) {
          scheduleUiSync(attempt + 1);
        }
        return;
      }
      settingsUi.fillFormFromConfig(CONFIG, (team) => getConfiguredTeamColor(team, CONFIG));
      updateUiStatus();
    }, delay);
  }

  function scheduleOverlayStart(attempt = 0) {
    if (pageUnloading || overlayStarted || overlayStartTimer !== null) return;
    const delay = attempt <= 0 ? 0 : (attempt < 20 ? 100 : 250);
    overlayStartTimer = setTimeout(() => {
      overlayStartTimer = null;
      if (pageUnloading || overlayStarted) return;
      if (mapProjection.isMapReady()) {
        initOverlay();
        overlayStarted = true;
        stopStartupObserver();
        return;
      }
      if (attempt < 240) {
        scheduleOverlayStart(attempt + 1);
      }
    }, delay);
  }

  function ensureStartupObserver() {
    if (pageUnloading || overlayStarted || startupObserver || typeof MutationObserver === 'undefined') {
      return;
    }
    const root = document.documentElement;
    if (!root) return;
    startupObserver = new MutationObserver(() => {
      scheduleOverlayStart(0);
    });
    startupObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function ensureWsClient() {
    if (wsClient) {
      return wsClient;
    }
    wsClient = createWebMapWsClient({
      getConfig: () => CONFIG,
      isDebugEnabled: () => isDebugPanelEnabled(),
      onSnapshotChanged: (snapshot, changeSet) => {
        latestSnapshot = snapshot;
        sameServerFilterEnabled = Boolean(snapshot?.tabState?.enabled);
        settingsUi.setServerFilterEnabled(sameServerFilterEnabled);
        latestPlayerMarks = snapshot && typeof snapshot.playerMarks === 'object' && snapshot.playerMarks
          ? snapshot.playerMarks
          : {};
        syncDerivedPlayersForChange(changeSet);
        lastErrorText = null;
        mapProjection.applySnapshotUpdate(snapshot, changeSet);
        flushVisiblePlayerUi();
        updateOverviewStatus();
        scheduleOverlayStart(0);
        scheduleUiStatusUpdate({
          recomputeDimensionOptions: changeSet.hasWorldRenderImpact,
          recomputeDebug: isDebugPanelEnabled(),
          delayMs: 180,
        });
      },
      onAckMessage: () => {},
      onWsStatusChanged: (status) => {
        wsConnected = status.wsConnected;
        lastErrorText = status.lastErrorText;
        lastWebMapMessageType = status.lastWebMapMessageType;
        lastWebMapMessageAt = status.lastWebMapMessageAt;
        serverProtocolVersion = status.serverProtocolVersion;
        scheduleUiStatusUpdate({ recomputeDebug: isDebugPanelEnabled(), delayMs: 120 });
      },
      onVersionIncompatible: (payload) => {
        if (payload.serverProtocolVersion) {
          serverProtocolVersion = payload.serverProtocolVersion;
        }
        updateUiStatus();
        if (versionIncompatibilityAlerted) return;
        versionIncompatibilityAlerted = true;

        const lines = [
          'Squaremap Overlay 连接失败：前后端版本不兼容。',
          payload.message,
        ];

        if (payload.serverProtocolVersion || payload.minimumCompatibleVersion) {
          lines.push(
            `服务端协议: ${payload.serverProtocolVersion || '未知'}，脚本最低兼容协议: ${payload.minimumCompatibleVersion || '未知'}`,
          );
        }
        lines.push('请更新油猴脚本或后端服务到兼容版本后再重试。');

        try {
          PAGE.alert(lines.join('\n'));
        } catch (_) {
          console.error('[Squaremap Overlay] 版本不兼容', payload);
        }
      },
    });
    return wsClient;
  }

  function startDeferredBoot() {
    if (pageUnloading || deferredBootStarted) return;
    deferredBootStarted = true;

    const run = () => {
      if (pageUnloading) return;
      if (!document.body) {
        deferredBootStarted = false;
        setTimeout(startDeferredBoot, 50);
        return;
      }

      ensureWsClient().connect();
      settingsUi.mountWhenReady();
      scheduleUiSync(0);
      ensureStartupObserver();
      scheduleOverlayStart(0);

      if (CONFIG.DEBUG) {
        console.log('[TeamViewRelay Overlay] deferred boot', {
          wsUrl: CONFIG.ADMIN_WS_URL,
          reconnectMs: CONFIG.RECONNECT_INTERVAL_MS,
          readyState: document.readyState,
        });
      }
    };

    run();
  }

  function boot() {
    installDebugConsoleApi();
    loadConfigFromStorage();
    CONFIG.ADMIN_WS_URL = normalizeWsUrl(CONFIG.ADMIN_WS_URL);
    CONFIG.ROOM_CODE = normalizeRoomCode(CONFIG.ROOM_CODE);

    try {
      mapProjection.installLeafletHook();
    } catch (error) {
      console.warn('[TeamViewRelay Overlay] installLeafletHook failed, fallback to DOM capture:', error);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startDeferredBoot, { once: true });
      return;
    }
    startDeferredBoot();
  }

  boot();
})();
