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

declare const unsafeWindow: Window | undefined;

(function () {
  'use strict';

  const PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
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

  function autoTeamFromName(nameText: string) {
    if (!CONFIG.AUTO_TEAM_FROM_NAME) return null;
    const name = String(nameText || '');
    if (!name) return null;

    const friendlyTags = parseTagList(CONFIG.FRIENDLY_TAGS);
    const enemyTags = parseTagList(CONFIG.ENEMY_TAGS);

    // 优先从 displayName 中提取方括号内的城镇名（如 [喀布尔]）进行标签匹配
    const townNameMatch = name.match(/\[([^\]]+)\]/);
    if (townNameMatch) {
      const townName = townNameMatch[1];
      if (friendlyTags.some((tag) => townName.includes(tag))) {
        return {
          team: 'friendly',
          color: getConfiguredTeamColor('friendly', CONFIG),
          label: '',
        };
      }
      if (enemyTags.some((tag) => townName.includes(tag))) {
        return {
          team: 'enemy',
          color: getConfiguredTeamColor('enemy', CONFIG),
          label: '',
        };
      }
    }

    // 如果没有城镇名，则使用完整名称进行匹配（兼容旧逻辑）
    if (friendlyTags.some((tag) => name.includes(tag))) {
      return {
        team: 'friendly',
        color: getConfiguredTeamColor('friendly', CONFIG),
        label: '',
      };
    }
    if (enemyTags.some((tag) => name.includes(tag))) {
      return {
        team: 'enemy',
        color: getConfiguredTeamColor('enemy', CONFIG),
        label: '',
      };
    }
    return null;
  }

  function getTabPlayerInfo(playerId: string) {
    const tabState = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.tabState : null;
    const reports = tabState && typeof tabState.reports === 'object' ? tabState.reports : null;
    if (!reports) return null;

    for (const report of Object.values(reports)) {
      if (!report || typeof report !== 'object') continue;
      const players = Array.isArray(report.players) ? report.players : [];
      for (const node of players) {
        if (!node || typeof node !== 'object') continue;
        const nodeId = String(node.uuid || node.id || '').trim();
        if (!nodeId || nodeId !== String(playerId)) continue;

        const prefixedName = String(node.prefixedName || '').trim();
        const displayNameRaw = String(node.displayName || '').trim();
        const name = String(node.name || '').trim();
        const parsedDisplay = parseMcDisplayName(displayNameRaw || prefixedName);
        const teamText = parsedDisplay.teamText || (prefixedName ? `[${prefixedName}]` : '');

        return {
          name,
          teamText,
          teamColor: parsedDisplay.color,
          // Prefer the canonical player name from TAB data. Older payloads may only
          // provide prefixed/display text, so keep those as a fallback.
          autoName: name || parsedDisplay.plain || prefixedName || null,
          displayNameRaw,
          prefixedName,
          matchedBy: 'uuid',
        };
      }
    }

    return null;
  }

  function getTabPlayerName(playerId: string) {
    const info = getTabPlayerInfo(playerId);
    return info ? info.autoName : null;
  }

  function getTabOnlinePlayerCount() {
    const tabState = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.tabState : null;
    const reports = tabState && typeof tabState.reports === 'object' ? tabState.reports : null;
    if (!reports) return 0;

    const ids = new Set<string>();
    for (const report of Object.values(reports)) {
      if (!report || typeof report !== 'object') continue;
      const players = Array.isArray(report.players) ? report.players : [];
      for (const node of players) {
        if (!node || typeof node !== 'object') continue;
        const playerId = String(node.uuid || node.id || node.name || '').trim();
        if (playerId) ids.add(playerId);
      }
    }
    return ids.size;
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

  function shouldRefreshPlayerListForChange(changeSet: SnapshotChangeSet | null) {
    if (!changeSet) return true;
    return (
      changeSet.kind === 'full' ||
      changeSet.dirtyScopes.players ||
      changeSet.dirtyScopes.playerMarks ||
      changeSet.dirtyScopes.tabState
    );
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
        markersOnMap: 0,
        waypointsOnMap: 0,
        battleChunksOnMap: 0,
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

  function getOnlinePlayers() {
    const snapshotPlayers = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.players : null;
    const tabState = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.tabState : null;
    const reports = tabState && typeof tabState.reports === 'object' ? tabState.reports : null;

    const mergedById = new Map<string, any>();

    const composeDisplayLabel = (rawLabel: string, rawPlayerName: string) => {
      const label = String(rawLabel || '').trim();
      const playerName = String(rawPlayerName || '').trim();
      if (!label) return playerName;
      if (!playerName) return label;
      if (label === playerName) return label;
      if (label.includes(playerName)) return label;
      return `${label} ${playerName}`;
    };

    const labelContainsName = (labelText: string, playerName: string) => {
      const label = String(labelText || '').trim();
      const name = String(playerName || '').trim();
      if (!label || !name) return false;
      return label.includes(name);
    };

    const upsertPlayer = (entry: any) => {
      if (!entry || !entry.playerId) return;
      const playerId = String(entry.playerId).trim();
      if (!playerId) return;

      const prev = mergedById.get(playerId);
      if (!prev) {
        const playerName = String(entry.playerName || '').trim();
        const displayLabel = composeDisplayLabel(entry.displayLabel, playerName);
        mergedById.set(playerId, {
          playerId,
          playerName,
          displayLabel,
          teamColor: entry.teamColor || null,
        });
        return;
      }

      const nextName = String(entry.playerName || '').trim();
      const nextDisplay = String(entry.displayLabel || '').trim();
      const keepName = prev.playerName || nextName;

      const prevDisplayWithName = composeDisplayLabel(prev.displayLabel, keepName);
      const nextDisplayWithName = composeDisplayLabel(nextDisplay, nextName || keepName);
      const prevHasName = labelContainsName(prevDisplayWithName, keepName);
      const nextHasName = labelContainsName(nextDisplayWithName, keepName);

      let keepDisplay = prevDisplayWithName || nextDisplayWithName || keepName;
      if ((!prevHasName && nextHasName) || (!prevDisplayWithName && nextDisplayWithName)) {
        keepDisplay = nextDisplayWithName;
      }
      const keepColor = prev.teamColor || entry.teamColor || null;

      mergedById.set(playerId, {
        playerId,
        playerName: keepName,
        displayLabel: keepDisplay,
        teamColor: keepColor,
      });
    };

    if (reports) {
      for (const report of Object.values(reports)) {
        if (!report || typeof report !== 'object') continue;
        const tabPlayers = Array.isArray(report.players) ? report.players : [];
        for (const node of tabPlayers) {
          if (!node || typeof node !== 'object') continue;
          const playerId = String(node.uuid || node.id || '').trim();
          if (!playerId) continue;

          const prefixedName = String(node.prefixedName || '').trim();
          const displayNameRaw = String(node.displayName || '').trim();
          const plainName = String(node.name || '').trim();
          const parsedDisplay = parseMcDisplayName(displayNameRaw || prefixedName);
          const playerName = plainName || parsedDisplay.plain || prefixedName || playerId;
          const displayLabel = composeDisplayLabel(prefixedName || parsedDisplay.plain, playerName);

          upsertPlayer({
            playerId,
            playerName,
            displayLabel,
            teamColor: parsedDisplay.color || null,
          });
        }
      }
    }

    if (snapshotPlayers && typeof snapshotPlayers === 'object') {
      for (const [playerId, rawNode] of Object.entries(snapshotPlayers)) {
        const data = getPlayerDataNode(rawNode);
        const fallbackName = String((data && data.playerName) || (data && data.playerUUID) || playerId || '').trim();
        const tabInfo = getTabPlayerInfo(String(playerId));
        const playerName = (tabInfo && tabInfo.name) ? tabInfo.name : (fallbackName || String(playerId));
        const displayLabel = composeDisplayLabel(tabInfo && tabInfo.teamText ? tabInfo.teamText : '', playerName);

        upsertPlayer({
          playerId: String(playerId),
          playerName,
          displayLabel,
          teamColor: tabInfo && tabInfo.teamColor ? tabInfo.teamColor : null,
        });
      }
    }

    const players = Array.from(mergedById.values()).map((item: any) => ({
      ...item,
      playerName: item.playerName || item.displayLabel || item.playerId,
      displayLabel: item.displayLabel || item.playerName || item.playerId,
    }));

    players.sort((a, b) => {
      const textA = String(a.displayLabel || a.playerName || a.playerId || '');
      const textB = String(b.displayLabel || b.playerName || b.playerId || '');
      return textA.localeCompare(textB, 'zh-Hans-CN');
    });
    return players;
  }

  function getMapVisiblePlayersForList() {
    const snapshotPlayers = latestSnapshot && typeof latestSnapshot === 'object' ? latestSnapshot.players : null;
    if (!snapshotPlayers || typeof snapshotPlayers !== 'object') {
      return [];
    }

    const wantedDim = normalizeDimension(CONFIG.TARGET_DIMENSION);
    const teamLabelMap: Record<string, string> = {
      friendly: '友军',
      enemy: '敌军',
      neutral: '中立',
    };

    const rows: Array<{
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
    }> = [];

    for (const [playerId, rawNode] of Object.entries(snapshotPlayers)) {
      const data = getPlayerDataNode(rawNode);
      if (!data) continue;

      const dim = normalizeDimension(data.dimension);
      if (wantedDim && dim !== wantedDim) continue;

      const x = readNumber(data.x);
      const z = readNumber(data.z);
      if (x === null || z === null) continue;

      const fallbackName = String(data.playerName || data.playerUUID || playerId || '').trim();
      const autoName = getTabPlayerName(String(playerId)) || fallbackName || String(playerId);
      const tabInfo = getTabPlayerInfo(String(playerId));
      const existingMark = getPlayerMark(String(playerId));
      const autoMark = autoTeamFromName(autoName);
      const existingMarkSource = existingMark ? normalizeMarkSource(existingMark.source) : 'manual';
      const existingActsAsAuto = Boolean(existingMark) && existingMarkSource === 'auto';
      const isManualMark = Boolean(existingMark) && !existingActsAsAuto;
      const effectiveMark = isManualMark
        ? existingMark
        : (autoMark || (existingActsAsAuto ? null : existingMark));

      const team = normalizeTeam(effectiveMark && effectiveMark.team ? effectiveMark.team : 'neutral');
      const teamColor = getConfiguredTeamColor(team, CONFIG);
      const townColor = normalizeColor(tabInfo && tabInfo.teamColor, '#93c5fd');
      const health = readNumber(data.health);
      const armor = readNumber(data.armor);

      rows.push({
        playerId: String(playerId),
        playerName: autoName,
        team: teamLabelMap[team] || teamLabelMap.neutral,
        teamColor,
        town: (tabInfo && String(tabInfo.teamText || '').trim()) || '-',
        townColor,
        health: health === null ? '-' : String(Math.round(health)),
        armor: armor === null ? '-' : String(Math.round(armor)),
        x,
        z,
      });
    }

    rows.sort((a, b) => a.playerName.localeCompare(b.playerName, 'zh-Hans-CN'));
    return rows;
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
        mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
        wsClient?.reconnect();
        refreshPlayerLists();
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

  function updateUiStatus(options: { recomputeDimensionOptions?: boolean; recomputeDebug?: boolean } = {}) {
    const startedAt = performance.now();
    if (options.recomputeDimensionOptions !== false) {
      updateDimensionOptionsCache();
    }
    const mapCounts = mapProjection.getCounts();
    const annotations = mapCounts.markers + mapCounts.waypoints;
    settingsUi.updateStatus(lastErrorText ? `错误: ${lastErrorText}` : '',
      {
        wsConnected,
        hasError: Boolean(lastErrorText),
        markerCount: annotations,
        battleChunkCount: mapCounts.battleChunks,
        roomCode: CONFIG.ROOM_CODE,
        targetDimension: CONFIG.TARGET_DIMENSION,
        dimensionOptions: cachedDimensionOptions,
        clientProtocolVersion: ADMIN_NETWORK_PROTOCOL_VERSION,
        serverProtocolVersion: serverProtocolVersion || '-',
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
        markersOnMap: Number(mapDebug.markers || 0),
        waypointsOnMap: Number(mapDebug.waypoints || 0),
        battleChunksOnMap: Number(mapDebug.battleChunks || 0),
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

  function refreshPlayerLists() {
    settingsUi.refreshPlayerSelector(getOnlinePlayers());
    settingsUi.refreshMapPlayerList(getMapVisiblePlayersForList());
  }

  function focusMapPlayerById(playerId: string) {
    const targetId = String(playerId || '').trim();
    if (!targetId) {
      lastErrorText = '玩家列表目标为空';
      updateUiStatus();
      return;
    }

    const mapPlayers = getMapVisiblePlayersForList();
    const target = mapPlayers.find((item) => item.playerId === targetId);
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
    const next = sanitizeConfig(settingsUi.readFormCandidate(CONFIG));
    Object.assign(CONFIG, next);
    if (previousDebugPanelEnabled && !isDebugPanelEnabled()) {
      wsClient?.clearDebugHistory?.();
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
      refreshPlayerLists();
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
      refreshPlayerLists();
    },
    onExportConfig: () => {
      exportConfig();
    },
    onImportConfig: () => {
      importConfigFromFile();
    },
    onReset: () => {
      Object.assign(CONFIG, DEFAULT_CONFIG);
      saveConfigToStorage();
      settingsUi.fillFormFromConfig(CONFIG, (team) => getConfiguredTeamColor(team, CONFIG));
      mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
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
      refreshPlayerLists();
      lastErrorText = null;
      updateUiStatus();
    },
    onFocusMapPlayer: (playerId) => {
      focusMapPlayerById(playerId);
    },
    onOverviewDimensionChanged: (dimension) => {
      const nextDimension = normalizeDimension(dimension) || DEFAULT_CONFIG.TARGET_DIMENSION;
      CONFIG.TARGET_DIMENSION = nextDimension;
      settingsUi.setTargetDimension(nextDimension);
      mapProjection.applyLatestSnapshotIfPossible(latestSnapshot);
      refreshPlayerLists();
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
      refreshPlayerLists();
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
        if (shouldRefreshPlayerListForChange(changeSet)) {
          refreshPlayerLists();
        }
        lastErrorText = null;
        mapProjection.applySnapshotUpdate(snapshot, changeSet);
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
