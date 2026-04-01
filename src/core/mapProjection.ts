import {
  getPlayerDataNode,
  normalizeColor,
  normalizeDimension,
  normalizeMarkSource,
  normalizeTeam,
  parseMcDisplayName,
  readNumber,
} from '../utils/overlayUtils';

type MapProjectionDeps = {
  page: Window;
  config: Record<string, any>;
  overlayStyleText: string;
  getPlayerMark: (playerId: string) => any;
  getTabPlayerInfo: (playerId: string) => any;
  getTabPlayerName: (playerId: string) => string | null;
  autoTeamFromName: (nameText: string) => any;
  getConfiguredTeamColor: (team: string) => string;
  maybeSyncAutoDetectedMarks: (candidates: any[]) => void;
  getLatestPlayerMarks: () => Record<string, any>;
  getWsConnected: () => boolean;
  onCreateTacticalWaypoint?: (payload: {
    x: number;
    z: number;
    label: string;
    tacticalType: string;
    color: string;
    ttlSeconds: number | null;
    permanent: boolean;
  }) => boolean;
  onDeleteTacticalWaypoint?: (payload: {
    waypointId: string;
  }) => boolean;
};

export function createMapProjection(deps: MapProjectionDeps) {
  const PAGE = deps.page;
  const CONFIG = deps.config;
  const GLOBAL_MAP_KEY_REGEX = /(map|leaflet|square)/i;

  let leafletRef: any = null;
  let capturedMap: any = null;
  let lastGlobalMapScanAt = 0;
  let guardedMapContainer: HTMLElement | null = null;
  let hoverPopupBlockedContainer: HTMLElement | null = null;
  let tacticalMenuEl: HTMLElement | null = null;
  let tacticalMenuOutsideClickHandler: ((event: MouseEvent) => void) | null = null;
  let tacticalMenuEscHandler: ((event: KeyboardEvent) => void) | null = null;
  let tacticalPreviewMarker: any | null = null;
  const markersById = new Map<string, any>();
  const waypointsById = new Map<string, any>();
  const battleChunkLayersById = new Map<string, any>();
  const trackedWaypointPositions = new Map<string, { x: number; z: number }>();
  const reporterEffectsById = new Map<string, { vision: ReporterEffectEntry | null; chunkArea: ReporterEffectEntry | null }>();
  const reporterEffectLayersByStyle = new Map<string, any>();

  type ReporterEffectEntry = {
    kind: 'vision' | 'chunkArea';
    styleKey: string;
    latLngs: any;
    style: {
      color: string;
      weight: number;
      opacity: number;
      fillColor: string;
      fillOpacity: number;
      fillRule?: 'evenodd' | 'nonzero';
      interactive: false;
      smoothFactor?: number;
    };
  };

  type ReporterIdentitySet = {
    ids: Set<string>;
    names: Set<string>;
  };

  const MAP_HOVER_BLOCK_CLASS = 'nodemc-map-hover-popup-blocked';
  const MAP_HOVER_BLOCK_STYLE = `
.${MAP_HOVER_BLOCK_CLASS} .leaflet-tooltip-pane,
.${MAP_HOVER_BLOCK_CLASS} .leaflet-tooltip,
.${MAP_HOVER_BLOCK_CLASS} .leaflet-popup-pane,
.${MAP_HOVER_BLOCK_CLASS} .leaflet-popup {
  display: none !important;
}
`;

  const guardedMouseEvents: Array<keyof HTMLElementEventMap> = ['click', 'dblclick', 'auxclick', 'contextmenu'];

  function escapeHtml(raw: unknown) {
    return String(raw || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch] as string));
  }

  function latLngToWorld(map: any, latLng: any) {
    const scale = Number.isFinite(map?.options?.scale) ? map.options.scale : 1;
    const safeScale = scale || 1;
    const x = Number(latLng?.lng) / safeScale;
    const z = -Number(latLng?.lat) / safeScale;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return null;
    }
    return { x, z };
  }

  function shouldEnableTacticalMapMarking() {
    return Boolean(CONFIG.ENABLE_TACTICAL_MAP_MARKING);
  }

  function getDefaultTacticalTtlSeconds() {
    const raw = Number(CONFIG.TACTICAL_MARK_DEFAULT_TTL_SECONDS);
    if (!Number.isFinite(raw)) return 180;
    return Math.max(10, Math.min(86400, Math.round(raw)));
  }

  function getTacticalTypeOptions() {
    return [
      { value: 'attack', name: '进攻', label: '⚔ 进攻此处', color: '#ef4444' },
      { value: 'defend', name: '防守', label: '🛡 防守此处', color: '#3b82f6' },
      { value: 'gather', name: '集结', label: '📣 集结此处', color: '#22c55e' },
      { value: 'scout', name: '侦查', label: '👁 侦查此处', color: '#f59e0b' },
      { value: 'danger', name: '危险', label: '⚠ 危险区域', color: '#f97316' },
      { value: 'custom', name: '自定义', label: '📍 自定义标点', color: '#0ea5e9' },
    ];
  }

  function sanitizeCustomTacticalLabel(raw: unknown) {
    const text = String(raw || '').trim();
    if (!text) return '📍 自定义标点';
    return text.slice(0, 64);
  }

  function closeTacticalMenu() {
    if (tacticalMenuOutsideClickHandler) {
      document.removeEventListener('mousedown', tacticalMenuOutsideClickHandler, true);
      tacticalMenuOutsideClickHandler = null;
    }
    if (tacticalMenuEscHandler) {
      document.removeEventListener('keydown', tacticalMenuEscHandler, true);
      tacticalMenuEscHandler = null;
    }
    if (tacticalMenuEl) {
      try { tacticalMenuEl.remove(); } catch (_) {}
      tacticalMenuEl = null;
    }
    if (tacticalPreviewMarker) {
      try { tacticalPreviewMarker.remove(); } catch (_) {}
      tacticalPreviewMarker = null;
    }
  }

  function buildTacticalPreviewHtml(label: string, color: string) {
    const safeLabel = escapeHtml(label || '战术标点');
    const safeColor = normalizeColor(color, '#ef4444');
    return `<div class="nodemc-tactical-anchor is-preview"><span class="n-tactical-icon" style="color:${safeColor};">📍</span><span class="n-tactical-label">预标点 · ${safeLabel}</span></div>`;
  }

  function upsertTacticalPreviewMarker(
    map: any,
    worldPos: { x: number; z: number },
    selectedType: { label: string; color: string }
  ) {
    if (!map || !leafletRef || !worldPos || !selectedType) return;

    const latLng = worldToLatLng(map, worldPos.x, worldPos.z);
    const html = buildTacticalPreviewHtml(selectedType.label, selectedType.color);

    if (tacticalPreviewMarker) {
      try {
        tacticalPreviewMarker.setLatLng(latLng);
        if (typeof tacticalPreviewMarker.setZIndexOffset === 'function') {
          tacticalPreviewMarker.setZIndexOffset(getWaypointZIndexOffset() + 400);
        }
        tacticalPreviewMarker.setIcon(
          leafletRef.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] })
        );
        return;
      } catch (_) {
        try { tacticalPreviewMarker.remove(); } catch (_) {}
        tacticalPreviewMarker = null;
      }
    }

    tacticalPreviewMarker = leafletRef.marker(latLng, {
      icon: leafletRef.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      zIndexOffset: getWaypointZIndexOffset() + 400,
      interactive: false,
      keyboard: false,
    });
    tacticalPreviewMarker.addTo(map);
  }

  function resolveTtlFromMenuValue(rawValue: string, customRawValue: string) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (value === 'long') {
      return { ttlSeconds: null, permanent: true };
    }
    if (value === 'default') {
      return { ttlSeconds: getDefaultTacticalTtlSeconds(), permanent: false };
    }
    if (value === 'custom') {
      const customNum = Number(customRawValue);
      if (!Number.isFinite(customNum)) return null;
      return {
        ttlSeconds: Math.max(10, Math.min(86400, Math.round(customNum))),
        permanent: false,
      };
    }
    const ttlNum = Number(value);
    if (!Number.isFinite(ttlNum)) return null;
    return {
      ttlSeconds: Math.max(10, Math.min(86400, Math.round(ttlNum))),
      permanent: false,
    };
  }

  function bindFloatingMenuInteractions(menu: HTMLElement) {
    menu.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    menu.addEventListener('wheel', (e) => {
      e.stopPropagation();
    });
    menu.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  function positionFloatingMenu(menu: HTMLElement, event: MouseEvent) {
    const margin = 12;
    const menuRect = menu.getBoundingClientRect();
    let left = event.clientX + 14;
    let top = event.clientY + 12;

    const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
    left = Math.max(margin, Math.min(maxLeft, left));
    top = Math.max(margin, Math.min(maxTop, top));

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function openTacticalMenuAtPointer(
    map: any,
    event: MouseEvent,
    worldPos: { x: number; z: number }
  ) {
    closeTacticalMenu();

    const typeOptions = getTacticalTypeOptions();
    const defaultTtl = getDefaultTacticalTtlSeconds();

    const menu = document.createElement('div');
    menu.className = 'nodemc-tactical-menu';
    menu.innerHTML = `
      <div class="nmc-tactical-title">战术标记</div>
      <label class="nmc-tactical-row">
        <span>标注类型</span>
        <select class="nmc-tactical-type"></select>
      </label>
      <label class="nmc-tactical-row nmc-tactical-label-row" style="display:none;">
        <span>标点文字</span>
        <input class="nmc-tactical-label-input" type="text" maxlength="64" placeholder="例如：📌 这里集合" />
      </label>
      <label class="nmc-tactical-row">
        <span>过期时间</span>
        <select class="nmc-tactical-ttl">
          <option value="default">默认（${defaultTtl}s）</option>
          <option value="60">1 分钟</option>
          <option value="180">3 分钟</option>
          <option value="600">10 分钟</option>
          <option value="1800">30 分钟</option>
          <option value="3600">1 小时</option>
          <option value="long">长期有效</option>
          <option value="custom">自定义秒数</option>
        </select>
      </label>
      <label class="nmc-tactical-row nmc-tactical-custom-row" style="display:none;">
        <span>自定义秒数</span>
        <input class="nmc-tactical-custom-ttl" type="number" min="10" max="86400" step="10" value="${defaultTtl}" />
      </label>
      <div class="nmc-tactical-actions">
        <button type="button" class="nmc-tactical-confirm">确认</button>
        <button type="button" class="nmc-tactical-cancel">取消</button>
      </div>
    `;

    const typeSelect = menu.querySelector('.nmc-tactical-type') as HTMLSelectElement | null;
    const customLabelRow = menu.querySelector('.nmc-tactical-label-row') as HTMLElement | null;
    const customLabelInput = menu.querySelector('.nmc-tactical-label-input') as HTMLInputElement | null;
    const ttlSelect = menu.querySelector('.nmc-tactical-ttl') as HTMLSelectElement | null;
    const customRow = menu.querySelector('.nmc-tactical-custom-row') as HTMLElement | null;
    const customInput = menu.querySelector('.nmc-tactical-custom-ttl') as HTMLInputElement | null;
    const confirmBtn = menu.querySelector('.nmc-tactical-confirm') as HTMLButtonElement | null;
    const cancelBtn = menu.querySelector('.nmc-tactical-cancel') as HTMLButtonElement | null;
    if (!typeSelect || !customLabelRow || !customLabelInput || !ttlSelect || !customRow || !customInput || !confirmBtn || !cancelBtn) {
      return false;
    }

    for (const item of typeOptions) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = `${item.name}（${item.label}）`;
      typeSelect.appendChild(option);
    }

    const syncPreviewFromSelection = () => {
      const selectedType = typeOptions.find((item) => item.value === typeSelect.value) || typeOptions[0];
      const isCustomType = selectedType.value === 'custom';
      const previewType = isCustomType
        ? {
          ...selectedType,
          label: sanitizeCustomTacticalLabel(customLabelInput.value),
        }
        : selectedType;
      upsertTacticalPreviewMarker(map, worldPos, previewType);
    };

    const syncCustomLabelVisibility = () => {
      const selectedType = typeOptions.find((item) => item.value === typeSelect.value) || typeOptions[0];
      const isCustomType = selectedType.value === 'custom';
      customLabelRow.style.display = isCustomType ? 'flex' : 'none';
      if (isCustomType && !customLabelInput.value.trim()) {
        customLabelInput.value = selectedType.label;
      }
    };

    syncCustomLabelVisibility();
    syncPreviewFromSelection();

    typeSelect.addEventListener('change', () => {
      syncCustomLabelVisibility();
      syncPreviewFromSelection();
      if (typeSelect.value === 'custom') {
        customLabelInput.focus();
      }
    });

    customLabelInput.addEventListener('input', () => {
      syncPreviewFromSelection();
    });

    bindFloatingMenuInteractions(menu);

    ttlSelect.addEventListener('change', () => {
      customRow.style.display = ttlSelect.value === 'custom' ? 'flex' : 'none';
      if (ttlSelect.value === 'custom') {
        customInput.focus();
      }
    });

    cancelBtn.addEventListener('click', () => {
      closeTacticalMenu();
    });

    confirmBtn.addEventListener('click', () => {
      const selectedType = typeOptions.find((item) => item.value === typeSelect.value) || typeOptions[0];
      const finalLabel = selectedType.value === 'custom'
        ? sanitizeCustomTacticalLabel(customLabelInput.value)
        : selectedType.label;
      const ttl = resolveTtlFromMenuValue(ttlSelect.value, customInput.value);
      if (!ttl) {
        customInput.focus();
        return;
      }

      if (typeof deps.onCreateTacticalWaypoint === 'function') {
        deps.onCreateTacticalWaypoint({
          x: worldPos.x,
          z: worldPos.z,
          label: finalLabel,
          tacticalType: selectedType.value,
          color: selectedType.color,
          ttlSeconds: ttl.ttlSeconds,
          permanent: ttl.permanent,
        });
      }
      closeTacticalMenu();
    });

    document.body.appendChild(menu);
    tacticalMenuEl = menu;
    positionFloatingMenu(menu, event);

    tacticalMenuOutsideClickHandler = (e: MouseEvent) => {
      const target = e.target;
      if (tacticalMenuEl && target instanceof Node && tacticalMenuEl.contains(target)) {
        return;
      }
      closeTacticalMenu();
    };
    tacticalMenuEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeTacticalMenu();
      }
    };

    setTimeout(() => {
      if (tacticalMenuOutsideClickHandler) {
        document.addEventListener('mousedown', tacticalMenuOutsideClickHandler, true);
      }
      if (tacticalMenuEscHandler) {
        document.addEventListener('keydown', tacticalMenuEscHandler, true);
      }
    }, 0);

    return true;
  }

  function openWaypointDeleteMenuAtPointer(event: MouseEvent, waypointId: string, waypointLabel: string | null) {
    closeTacticalMenu();

    const menu = document.createElement('div');
    menu.className = 'nodemc-tactical-menu';
    menu.innerHTML = `
      <div class="nmc-tactical-title">删除战术标点</div>
      <label class="nmc-tactical-row">
        <span>目标标点</span>
        <input class="nmc-tactical-delete-label" type="text" readonly value="${escapeHtml(waypointLabel || waypointId)}" />
      </label>
      <div class="nmc-tactical-row">
        <span>确认删除这个 waypoint 吗？</span>
      </div>
      <div class="nmc-tactical-actions">
        <button type="button" class="nmc-tactical-confirm">确认删除</button>
        <button type="button" class="nmc-tactical-cancel">取消</button>
      </div>
    `;

    const confirmBtn = menu.querySelector('.nmc-tactical-confirm') as HTMLButtonElement | null;
    const cancelBtn = menu.querySelector('.nmc-tactical-cancel') as HTMLButtonElement | null;
    if (!confirmBtn || !cancelBtn) {
      return false;
    }

    bindFloatingMenuInteractions(menu);

    cancelBtn.addEventListener('click', () => {
      closeTacticalMenu();
    });

    confirmBtn.addEventListener('click', () => {
      if (typeof deps.onDeleteTacticalWaypoint === 'function') {
        deps.onDeleteTacticalWaypoint({ waypointId });
      }
      closeTacticalMenu();
    });

    document.body.appendChild(menu);
    tacticalMenuEl = menu;
    positionFloatingMenu(menu, event);

    tacticalMenuOutsideClickHandler = (e: MouseEvent) => {
      const target = e.target;
      if (tacticalMenuEl && target instanceof Node && tacticalMenuEl.contains(target)) {
        return;
      }
      closeTacticalMenu();
    };
    tacticalMenuEscHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeTacticalMenu();
      }
    };

    setTimeout(() => {
      if (tacticalMenuOutsideClickHandler) {
        document.addEventListener('mousedown', tacticalMenuOutsideClickHandler, true);
      }
      if (tacticalMenuEscHandler) {
        document.addEventListener('keydown', tacticalMenuEscHandler, true);
      }
    }, 0);

    return true;
  }

  function maybeHandleTacticalMarkPlacement(event: MouseEvent) {
    if (!shouldBlockMapLeftRightClick()) return false;
    if (!shouldEnableTacticalMapMarking()) return false;
    if (event.type !== 'contextmenu' || event.button !== 2) return false;
    if (typeof deps.onCreateTacticalWaypoint !== 'function') return false;

    const map = capturedMap || findMapByDom();
    if (!map || !leafletRef || !map._loaded) return false;
    const latLng = typeof map.mouseEventToLatLng === 'function' ? map.mouseEventToLatLng(event) : null;
    if (!latLng) return false;
    const pos = latLngToWorld(map, latLng);
    if (!pos) return false;

    return openTacticalMenuAtPointer(map, event, pos);
  }

  function maybeHandleWaypointDelete(event: MouseEvent, waypointId: string, waypointLabel: string | null) {
    if (!shouldBlockMapLeftRightClick()) return false;
    if (!shouldEnableTacticalMapMarking()) return false;
    if (event.button !== 2) return false;
    if (typeof deps.onDeleteTacticalWaypoint !== 'function') return false;

    const id = String(waypointId || '').trim();
    if (!id) return false;

    return openWaypointDeleteMenuAtPointer(event, id, waypointLabel);
  }

  function findWaypointTargetInfo(target: EventTarget | null) {
    if (!(target instanceof Element)) return null;
    const anchor = target.closest('[data-nodemc-waypoint-id]');
    if (!(anchor instanceof HTMLElement)) return null;
    const waypointId = String(anchor.dataset.nodemcWaypointId || '').trim();
    if (!waypointId) return null;
    const waypointLabel = String(anchor.dataset.nodemcWaypointLabel || '').trim() || null;
    return { waypointId, waypointLabel };
  }

  function shouldBlockMapLeftRightClick() {
    return Boolean(CONFIG.BLOCK_MAP_LEFT_RIGHT_CLICK);
  }

  function shouldBlockMapHoverPopup() {
    return Boolean(CONFIG.BLOCK_MAP_HOVER_POPUP);
  }

  function shouldInterceptMouseEvent(event: MouseEvent) {
    if (!shouldBlockMapLeftRightClick()) return false;
    if (event.type === 'contextmenu') return true;
    if (event.type === 'click' || event.type === 'dblclick') {
      return event.button === 0 || event.button === 2;
    }
    if (event.type === 'auxclick') {
      return event.button === 2;
    }
    return false;
  }

  function onGuardedMouseEvent(event: Event) {
    const mouseEvent = event as MouseEvent;
    if (!shouldInterceptMouseEvent(mouseEvent)) return;
    const waypointTarget = findWaypointTargetInfo(mouseEvent.target);
    if (waypointTarget && maybeHandleWaypointDelete(mouseEvent, waypointTarget.waypointId, waypointTarget.waypointLabel)) {
      mouseEvent.preventDefault();
      mouseEvent.stopPropagation();
      if (typeof mouseEvent.stopImmediatePropagation === 'function') {
        mouseEvent.stopImmediatePropagation();
      }
      return;
    }
    maybeHandleTacticalMarkPlacement(mouseEvent);
    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    if (typeof mouseEvent.stopImmediatePropagation === 'function') {
      mouseEvent.stopImmediatePropagation();
    }
  }

  function detachMapInteractionGuard() {
    closeTacticalMenu();
    if (!guardedMapContainer) return;
    for (const eventName of guardedMouseEvents) {
      guardedMapContainer.removeEventListener(eventName, onGuardedMouseEvent, true);
    }
    guardedMapContainer = null;
  }

  function ensureMapInteractionGuard() {
    const map = capturedMap || findMapByDom();
    const container = map && map._container instanceof HTMLElement ? map._container : null;
    if (!container || !container.isConnected) {
      detachMapInteractionGuard();
      detachMapHoverPopupBlock();
      return;
    }

    if (!shouldBlockMapLeftRightClick()) {
      detachMapInteractionGuard();
    } else if (guardedMapContainer !== container) {
      detachMapInteractionGuard();
      guardedMapContainer = container;
      for (const eventName of guardedMouseEvents) {
        guardedMapContainer.addEventListener(eventName, onGuardedMouseEvent, true);
      }
    }

    if (!shouldBlockMapHoverPopup()) {
      detachMapHoverPopupBlock();
      return;
    }

    if (hoverPopupBlockedContainer === container) {
      return;
    }

    detachMapHoverPopupBlock();
    hoverPopupBlockedContainer = container;
    hoverPopupBlockedContainer.classList.add(MAP_HOVER_BLOCK_CLASS);
  }

  function detachMapHoverPopupBlock() {
    if (!hoverPopupBlockedContainer) return;
    hoverPopupBlockedContainer.classList.remove(MAP_HOVER_BLOCK_CLASS);
    hoverPopupBlockedContainer = null;
  }

  function ensureMapHoverPopupStyles() {
    const style = document.getElementById('nodemc-map-hover-popup-style') as HTMLStyleElement | null;
    if (style) {
      if (style.textContent !== MAP_HOVER_BLOCK_STYLE) {
        style.textContent = MAP_HOVER_BLOCK_STYLE;
      }
      return;
    }
    const blockStyle = document.createElement('style');
    blockStyle.id = 'nodemc-map-hover-popup-style';
    blockStyle.textContent = MAP_HOVER_BLOCK_STYLE;
    document.head.appendChild(blockStyle);
  }

  function isLeafletMapCandidate(value: any) {
    return Boolean(
      value
      && typeof value === 'object'
      && typeof value.setView === 'function'
      && typeof value.getCenter === 'function'
      && typeof value.getZoom === 'function'
      && value._container
    );
  }

  function getOwnDataPropertyValue(obj: any, key: string) {
    if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(obj, key);
    } catch (_) {
      return undefined;
    }
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) return undefined;
    return descriptor.value;
  }

  function captureMap(value: any) {
    if (!isLeafletMapCandidate(value)) return null;
    capturedMap = value;
    return value;
  }

  function patchLeaflet(leafletObj: any) {
    if (!leafletObj || !leafletObj.Map || leafletObj.__nodemcProjectionPatched) {
      return;
    }
    leafletObj.__nodemcProjectionPatched = true;
    leafletRef = leafletObj;

    const originalInitialize = leafletObj.Map.prototype.initialize;
    leafletObj.Map.prototype.initialize = function (...args: any[]) {
      captureMap(this);
      return originalInitialize.apply(this, args);
    };

    const originalSetView = leafletObj.Map.prototype.setView;
    if (typeof originalSetView === 'function') {
      leafletObj.Map.prototype.setView = function (...args: any[]) {
        captureMap(this);
        return originalSetView.apply(this, args);
      };
    }

    const originalPanTo = leafletObj.Map.prototype.panTo;
    if (typeof originalPanTo === 'function') {
      leafletObj.Map.prototype.panTo = function (...args: any[]) {
        captureMap(this);
        return originalPanTo.apply(this, args);
      };
    }

    const originalFitBounds = leafletObj.Map.prototype.fitBounds;
    if (typeof originalFitBounds === 'function') {
      leafletObj.Map.prototype.fitBounds = function (...args: any[]) {
        captureMap(this);
        return originalFitBounds.apply(this, args);
      };
    }
  }

  function installLeafletHook() {
    let _L = getOwnDataPropertyValue(PAGE as any, 'L');

    try {
      Object.defineProperty(PAGE, 'L', {
        configurable: true,
        enumerable: true,
        get() {
          return _L;
        },
        set(value) {
          _L = value;
          patchLeaflet(value);
        },
      });
    } catch (error) {
      if (CONFIG.DEBUG) {
        console.warn('[TeamViewRelay Overlay] hook window.L failed, fallback to direct access:', error);
      }
    }

    if (_L) {
      patchLeaflet(_L);
    }
  }

  function findMapByDom() {
    if (!leafletRef || !leafletRef.Map || !document.querySelector) {
      return null;
    }

    const mapContainer = document.querySelector('#map.leaflet-container, #map .leaflet-container, .leaflet-container') as Record<string, any> | null;
    if (!mapContainer) {
      return null;
    }

    if (capturedMap && capturedMap._container === mapContainer) {
      return capturedMap;
    }

    for (const key of Object.keys(mapContainer)) {
      if (!key.startsWith('_leaflet_')) continue;
      const maybeMap = mapContainer[key];
      if (isLeafletMapCandidate(maybeMap)) {
        return captureMap(maybeMap);
      }
    }

    const now = Date.now();
    if (now - lastGlobalMapScanAt < 300) {
      return null;
    }
    lastGlobalMapScanAt = now;

    const globalMap = findMapFromWindowGlobals(mapContainer);
    if (globalMap) {
      return captureMap(globalMap);
    }

    return null;
  }

  function findMapFromWindowGlobals(mapContainer: any) {
    const pageObj = PAGE as Record<string, any>;
    const keys = Object.keys(pageObj);
    for (const key of keys) {
      if (!GLOBAL_MAP_KEY_REGEX.test(key)) continue;
      const value = getOwnDataPropertyValue(pageObj, key);
      if (value === undefined) continue;

      if (isLeafletMapCandidate(value) && value._container === mapContainer) {
        return value;
      }

      if (!value || typeof value !== 'object') continue;

      const nestedKeys = Object.keys(value);
      for (const nestedKey of nestedKeys) {
        if (!GLOBAL_MAP_KEY_REGEX.test(nestedKey)) continue;
        const nested = getOwnDataPropertyValue(value, nestedKey);
        if (nested === undefined) continue;
        if (isLeafletMapCandidate(nested) && nested._container === mapContainer) {
          return nested;
        }
      }
    }
    return null;
  }

  function ensureOverlayStyles() {
    if (document.getElementById('nodemc-projection-style')) {
      ensureMapHoverPopupStyles();
      return;
    }
    const style = document.createElement('style');
    style.id = 'nodemc-projection-style';
    style.textContent = deps.overlayStyleText;
    document.head.appendChild(style);
    ensureMapHoverPopupStyles();
  }

  function worldToLatLng(map: any, x: number, z: number) {
    const scale = Number.isFinite(map?.options?.scale) ? map.options.scale : 1;
    return leafletRef.latLng(-z * scale, x * scale);
  }

  function getMarkerVisualConfig(markerKind: string) {
    const isHorse = markerKind === 'horse';
    const isArmorStandPair = markerKind === 'armor-stand-pair';
    const iconSizeRaw = Number(isHorse ? CONFIG.HORSE_ICON_SIZE : CONFIG.PLAYER_ICON_SIZE);
    const textSizeRaw = Number(isHorse ? CONFIG.HORSE_TEXT_SIZE : CONFIG.PLAYER_TEXT_SIZE);
    const iconSizeFallback = isHorse ? 14 : (isArmorStandPair ? 12 : 10);
    const iconSizeBase = Number.isFinite(iconSizeRaw) ? Math.max(6, Math.min(40, Math.round(iconSizeRaw))) : iconSizeFallback;
    const iconSize = isArmorStandPair ? Math.max(10, iconSizeBase + 2) : iconSizeBase;
    const textSize = Number.isFinite(textSizeRaw) ? Math.max(8, Math.min(32, Math.round(textSizeRaw))) : 12;
    return {
      iconSize,
      textSize,
      labelOffset: isArmorStandPair ? iconSize + 4 : iconSize,
    };
  }

  function getReporterVisionRadiusBlocks() {
    const radius = readNumber(CONFIG.REPORTER_VISION_RADIUS);
    if (radius === null) return 64;
    return Math.max(8, Math.min(4096, Math.round(radius)));
  }

  function getReporterChunkRadius() {
    const radius = readNumber(CONFIG.REPORTER_CHUNK_RADIUS);
    if (radius === null) return 2;
    return Math.max(0, Math.min(64, Math.round(radius)));
  }

  function getReporterVisionOpacity() {
    const opacity = readNumber(CONFIG.REPORTER_VISION_OPACITY);
    if (opacity === null) return 0.1;
    return Math.max(0.02, Math.min(0.9, opacity));
  }

  function getReporterChunkOpacity() {
    const opacity = readNumber(CONFIG.REPORTER_CHUNK_OPACITY);
    if (opacity === null) return 0.11;
    return Math.max(0.02, Math.min(0.9, opacity));
  }

  function getBattleChunkFillOpacity() {
    const opacity = readNumber(CONFIG.BATTLE_CHUNK_FILL_OPACITY);
    if (opacity === null) return 0.32;
    return Math.max(0.02, Math.min(0.95, opacity));
  }

  function shouldHighlightBattleChunkCore() {
    return Boolean(CONFIG.BATTLE_CHUNK_HIGHLIGHT_CORE);
  }

  function shouldShowBattleChunkOutline() {
    return Boolean(CONFIG.BATTLE_CHUNK_SHOW_OUTLINE);
  }

  function shouldShowBattleChunkDebug() {
    return Boolean(CONFIG.BATTLE_CHUNK_DEBUG);
  }

  function buildBattleChunkBounds(map: any, chunkX: number, chunkZ: number) {
    const minX = chunkX * 16;
    const maxX = (chunkX + 1) * 16;
    const minZ = chunkZ * 16;
    const maxZ = (chunkZ + 1) * 16;
    return leafletRef.latLngBounds(
      worldToLatLng(map, minX, minZ),
      worldToLatLng(map, maxX, maxZ),
    );
  }

  function buildBattleChunkStyle(payload: any) {
    const color = normalizeColor(payload?.colorRaw, '#ffffff');
    const fillOpacity = getBattleChunkFillOpacity();
    const showOutline = shouldShowBattleChunkOutline();
    const markerType = String(payload?.markerType || '').trim();
    const renderMode = markerType === 'war_core' && shouldHighlightBattleChunkCore()
      ? 'core_outline'
      : 'normal_chunk';
    const coreOutlineColor = normalizeColor(CONFIG.BATTLE_CHUNK_CORE_HIGHLIGHT_COLOR, '#FF4DFF');

    if (renderMode === 'core_outline') {
      return {
        renderMode,
        style: {
          color: coreOutlineColor,
          weight: showOutline ? 3.2 : 2.6,
          opacity: showOutline ? 0.98 : 0.94,
          fillColor: color,
          fillOpacity: Math.max(0.16, Math.min(0.72, fillOpacity)),
          interactive: shouldShowBattleChunkDebug(),
          bubblingMouseEvents: false,
          className: 'tv-battle-chunk-core-outline',
        },
      };
    }

    return {
      renderMode,
      style: {
        color,
        weight: showOutline ? 0.8 : 0,
        opacity: showOutline ? Math.max(0.35, Math.min(1, fillOpacity + 0.35)) : 0,
        fillColor: color,
        fillOpacity,
        interactive: shouldShowBattleChunkDebug(),
        bubblingMouseEvents: false,
      },
    };
  }

  function buildBattleChunkTooltip(chunkId: string, payload: any) {
    const symbol = escapeHtml(String(payload?.symbol || '').trim() || ' ');
    const markerType = escapeHtml(String(payload?.markerType || '').trim() || '');
    const colorRaw = escapeHtml(String(payload?.colorRaw || '').trim() || '-');
    const colorNote = escapeHtml(String(payload?.colorNote || '').trim() || '');
    const dimension = escapeHtml(String(payload?.dimension || '').trim() || '');
    const chunkX = Number(payload?.chunkX);
    const chunkZ = Number(payload?.chunkZ);
    const observedAt = Number(payload?.observedAt);
    const positionSampledAt = Number(payload?.positionSampledAt);
    const alignmentSource = escapeHtml(String(payload?.alignmentSource || '').trim() || '');
    const renderMode = escapeHtml(String(payload?.renderMode || '').trim() || '');
    const observedText = Number.isFinite(observedAt) ? new Date(observedAt).toLocaleString() : '-';
    const sampledText = Number.isFinite(positionSampledAt) ? new Date(positionSampledAt).toLocaleString() : '-';
    const lines = [
      `<b>${escapeHtml(chunkId)}</b>`,
      `chunk: ${Number.isFinite(chunkX) ? Math.round(chunkX) : '?'} , ${Number.isFinite(chunkZ) ? Math.round(chunkZ) : '?'}`,
      `symbol: ${symbol}`,
      `color: ${colorRaw}`,
    ];
    if (markerType) {
      lines.push(`markerType: ${markerType}`);
    }
    if (colorNote) {
      lines.push(`note: ${colorNote}`);
    }
    if (dimension) {
      lines.push(`dim: ${dimension}`);
    }
    lines.push(`at: ${escapeHtml(observedText)}`);
    if (alignmentSource) {
      lines.push(`align: ${alignmentSource}`);
    }
    lines.push(`sampledAt: ${escapeHtml(sampledText)}`);
    if (renderMode) {
      lines.push(`renderMode: ${renderMode}`);
    }
    return lines.join('<br />');
  }

  function parseBooleanFlag(value: unknown) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    return text === '1' || text === 'true' || text === 'yes' || text === 'on';
  }

  function getReporterEffectColor(configColorKey: 'REPORTER_VISION_COLOR' | 'REPORTER_CHUNK_COLOR', fallbackColor: string) {
    const text = String(CONFIG[configColorKey] || '').trim();
    if (!text) return fallbackColor;
    return normalizeColor(text, fallbackColor);
  }

  function normalizeReporterName(value: unknown) {
    return String(value || '').trim().toLowerCase();
  }

  function hasHalfBlockFraction(value: number) {
    if (!Number.isFinite(value)) return false;
    const fraction = value - Math.floor(value);
    return Math.abs(fraction - 0.5) < 1e-6;
  }

  function buildArmorStandPairKey(dimension: string, x: number, z: number) {
    return `${dimension}|${x.toFixed(3)}|${z.toFixed(3)}`;
  }

  function collectRenderableArmorStandPairs(snapshot: any, wantedDim: string) {
    const entities = snapshot && typeof snapshot === 'object' ? snapshot.entities : null;
    if (!entities || typeof entities !== 'object') return [];

    const labelRegex = /^§[0-9a-fA-F]\[[^\]]+\]$/;
    const timerRegex = /^\[\d{2}:\d{2}\]$/;
    const grouped = new Map<string, {
      x: number;
      z: number;
      labels: Array<{ name: string; color: string | null; y: number }>;
      timers: Array<{ name: string; y: number }>;
    }>();

    for (const rawNode of Object.values(entities)) {
      const data = getPlayerDataNode(rawNode);
      if (!data) continue;

      const entityType = String(data.entityType || '').trim().toLowerCase();
      if (entityType !== 'entity.minecraft.armor_stand') continue;

      const dim = normalizeDimension(data.dimension);
      if (wantedDim && dim !== wantedDim) continue;

      const x = readNumber(data.x);
      const y = readNumber(data.y);
      const z = readNumber(data.z);
      if (x === null || z === null) continue;
      if (!hasHalfBlockFraction(x) || !hasHalfBlockFraction(z)) continue;

      const rawName = String(data.entityName || '').trim();
      if (!rawName) continue;

      const parsedName = parseMcDisplayName(rawName);
      const plainName = String(parsedName.plain || '').trim();
      const key = buildArmorStandPairKey(dim, x, z);
      let group = grouped.get(key);
      if (!group) {
        group = { x, z, labels: [], timers: [] };
        grouped.set(key, group);
      }

      if (labelRegex.test(rawName) && /^\[[^\]]+\]$/.test(plainName)) {
        group.labels.push({
          name: plainName,
          color: parsedName.color || null,
          y: y === null ? 0 : y,
        });
        continue;
      }

      if (timerRegex.test(plainName)) {
        group.timers.push({
          name: plainName,
          y: y === null ? 0 : y,
        });
      }
    }

    const markers: Array<{ markerId: string; x: number; z: number; name: string; color: string }> = [];
    for (const [key, group] of grouped.entries()) {
      if (!group.labels.length || !group.timers.length) continue;

      const labelEntry = group.labels.sort((left, right) => right.y - left.y)[0];
      const timerEntry = group.timers.sort((left, right) => right.y - left.y)[0];
      const color = normalizeColor(labelEntry.color, deps.getConfiguredTeamColor('neutral'));

      markers.push({
        markerId: `entity:armor-stand-pair:${key}`,
        x: group.x,
        z: group.z,
        name: `[🚩插旗] ${labelEntry.name} ${timerEntry.name}`,
        color,
      });
    }

    return markers;
  }

  function addReporterName(target: Set<string>, value: unknown) {
    const normalized = normalizeReporterName(value);
    if (normalized) target.add(normalized);
  }

  function getReportingPlayerIdentities(snapshot: any): ReporterIdentitySet {
    const ids = new Set<string>();
    const names = new Set<string>();

    const connections = Array.isArray(snapshot?.connections) ? snapshot.connections : [];
    for (const connectionId of connections) {
      const text = String(connectionId || '').trim();
      if (text) ids.add(text);
    }

    const tabState = snapshot && typeof snapshot === 'object' ? snapshot.tabState : null;
    const reports = tabState && typeof tabState.reports === 'object' ? tabState.reports : null;
    if (!reports) return { ids, names };

    for (const [reportKey, rawReport] of Object.entries(reports)) {
      const report = rawReport && typeof rawReport === 'object' ? rawReport as Record<string, any> : null;
      const reportId = String(reportKey || '').trim();
      const submitPlayerId = String(report?.submitPlayerId || '').trim();

      if (reportId) ids.add(reportId);
      if (submitPlayerId) ids.add(submitPlayerId);

      const players = Array.isArray(report?.players) ? report.players : [];
      const reporterRow = players.find((item) => {
        if (!item || typeof item !== 'object') return false;
        const itemUuid = String((item as any).uuid || (item as any).playerUUID || (item as any).id || '').trim();
        return Boolean(itemUuid) && (itemUuid === reportId || itemUuid === submitPlayerId);
      });

      if (reporterRow && typeof reporterRow === 'object') {
        addReporterName(names, (reporterRow as any).name);
        addReporterName(names, (reporterRow as any).displayName);
        addReporterName(names, (reporterRow as any).prefixedName);
      }
    }

    return { ids, names };
  }

  function isReportingPlayer(playerId: string, rawNode: any, playerData: any, reporterIdentities: ReporterIdentitySet) {
    const idCandidates = new Set<string>();
    const pushId = (value: unknown) => {
      const text = String(value || '').trim();
      if (text) idCandidates.add(text);
    };

    pushId(playerId);
    pushId(playerData && (playerData.playerUUID || playerData.uuid || playerData.id));
    pushId(rawNode && (rawNode.playerUUID || rawNode.uuid || rawNode.id));

    for (const maybeId of idCandidates) {
      if (reporterIdentities.ids.has(maybeId)) return true;
    }

    const nameCandidates = [
      playerData && (playerData.playerName || playerData.name),
      rawNode && (rawNode.playerName || rawNode.name),
    ];
    for (const candidate of nameCandidates) {
      if (reporterIdentities.names.has(normalizeReporterName(candidate))) return true;
    }

    if (!rawNode || typeof rawNode !== 'object') return false;
    const submitPlayerId = String((rawNode as any).submitPlayerId || '').trim();
    if (!submitPlayerId) return false;

    if (reporterIdentities.ids.has(submitPlayerId)) return true;
    for (const maybeId of idCandidates) {
      if (submitPlayerId === maybeId) return true;
    }
    return false;
  }

  function buildReporterEffectStyleKey(kind: 'vision' | 'chunkArea', style: ReporterEffectEntry['style']) {
    return [
      kind,
      style.color,
      style.weight,
      style.opacity,
      style.fillColor,
      style.fillOpacity,
      style.fillRule ?? '',
      style.smoothFactor ?? '',
    ].join('|');
  }

  function collectReporterEffectLatLngs(kind: 'vision' | 'chunkArea', groupedEntries: ReporterEffectEntry[]) {
    if (kind === 'chunkArea') {
      const merged: any[] = [];
      for (const entry of groupedEntries) {
        if (Array.isArray(entry.latLngs)) {
          merged.push(...entry.latLngs);
        }
      }
      return merged;
    }

    if (groupedEntries.length === 1) {
      return groupedEntries[0].latLngs;
    }
    return groupedEntries.map((entry) => entry.latLngs);
  }

  function rebuildReporterEffectLayers(map: any) {
    const grouped = new Map<string, { kind: 'vision' | 'chunkArea'; style: ReporterEffectEntry['style']; entries: ReporterEffectEntry[] }>();

    for (const layers of reporterEffectsById.values()) {
      for (const entry of [layers.vision, layers.chunkArea]) {
        if (!entry) continue;
        const bucket = grouped.get(entry.styleKey);
        if (bucket) {
          bucket.entries.push(entry);
          continue;
        }
        grouped.set(entry.styleKey, {
          kind: entry.kind,
          style: entry.style,
          entries: [entry],
        });
      }
    }

    for (const [styleKey, group] of grouped.entries()) {
      const latLngs = collectReporterEffectLatLngs(group.kind, group.entries);
      const existingLayer = reporterEffectLayersByStyle.get(styleKey);
      if (existingLayer) {
        existingLayer.setLatLngs(latLngs);
        existingLayer.setStyle(group.style);
        continue;
      }

      const layer = leafletRef.polygon(latLngs, group.style).addTo(map);
      reporterEffectLayersByStyle.set(styleKey, layer);
    }

    for (const [styleKey, layer] of reporterEffectLayersByStyle.entries()) {
      if (grouped.has(styleKey)) continue;
      try { layer.remove(); } catch (_) {}
      reporterEffectLayersByStyle.delete(styleKey);
    }
  }

  function buildWorldCircleLatLngs(map: any, centerX: number, centerZ: number, radiusBlocks: number, segments = 48) {
    const points: any[] = [];
    const safeSegments = Math.max(16, Math.min(96, Math.round(segments)));
    for (let i = 0; i < safeSegments; i += 1) {
      const rad = (Math.PI * 2 * i) / safeSegments;
      const px = centerX + Math.cos(rad) * radiusBlocks;
      const pz = centerZ + Math.sin(rad) * radiusBlocks;
      points.push(worldToLatLng(map, px, pz));
    }
    return points;
  }

  function buildChunkCircleCellsLatLngs(map: any, centerX: number, centerZ: number, chunkRadius: number) {
    const cx = Math.floor(centerX / 16);
    const cz = Math.floor(centerZ / 16);
    const radius = chunkRadius;
    const cells: any[] = [];

    for (let dx = -chunkRadius; dx <= chunkRadius; dx += 1) {
      for (let dz = -chunkRadius; dz <= chunkRadius; dz += 1) {
        // Use Chebyshev distance (max(|dx|, |dz|)) so the area is a square of chunks
        // around the center chunk, matching chunk-distance semantics.
        if (Math.max(Math.abs(dx), Math.abs(dz)) > radius) continue;

        const chunkX = cx + dx;
        const chunkZ = cz + dz;
        const minX = chunkX * 16;
        const maxX = (chunkX + 1) * 16;
        const minZ = chunkZ * 16;
        const maxZ = (chunkZ + 1) * 16;

        cells.push([
          worldToLatLng(map, minX, minZ),
          worldToLatLng(map, maxX, minZ),
          worldToLatLng(map, maxX, maxZ),
          worldToLatLng(map, minX, maxZ),
        ]);
      }
    }

    return cells;
  }

  function buildMarkerHtml(
    name: string,
    x: number,
    z: number,
    health: number | null,
    mark: any,
    townInfo: any,
    markerKind = 'player',
    isReporter = false,
    isRiding = false
  ) {
    const isHorse = markerKind === 'horse';
    const isArmorStandPair = markerKind === 'armor-stand-pair';
    const team = mark ? normalizeTeam(mark.team) : 'neutral';
    const color = mark ? normalizeColor(mark.color, deps.getConfiguredTeamColor(team)) : deps.getConfiguredTeamColor(team);
    const showIcon = isArmorStandPair ? true : Boolean(CONFIG.SHOW_PLAYER_ICON);
    const showText = isHorse ? Boolean(CONFIG.SHOW_HORSE_TEXT) : (isArmorStandPair ? true : Boolean(CONFIG.SHOW_PLAYER_TEXT));
    if (!showIcon && !showText) {
      return '';
    }

    let text = name;
    if (CONFIG.SHOW_COORDS) {
      text += ` (${Math.round(x)}, ${Math.round(z)})`;
    }
    if (Number.isFinite(health) && (health as number) > 0) {
      text += ` ❤${Math.round(health as number)}`;
    }

    const teamText = team === 'friendly' ? '友军' : team === 'enemy' ? '敌军' : '中立';
    const noteText = mark && mark.label ? String(mark.label) : '';
    const townText = townInfo && typeof townInfo.text === 'string' ? townInfo.text.trim() : '';
    const safeName = escapeHtml(text);
    const safeTeam = escapeHtml(teamText);
    const safeNote = escapeHtml(noteText);
    const safeTown = escapeHtml(townText);
    const ridingHtml = markerKind === 'player' && isRiding
      ? `<span class="n-ride"> · 🐎</span>`
      : '';
    const visual = getMarkerVisualConfig(markerKind);
    const useReporterHighlight = markerKind === 'player' && isReporter && Boolean(CONFIG.REPORTER_STAR_ICON);
    const iconSize = useReporterHighlight ? Math.max(15, visual.iconSize + 3) : visual.iconSize;

    const iconContent = isHorse ? '🐎' : (isArmorStandPair ? '⌖' : '');
    const iconExtraClass = `${isHorse ? ' is-horse' : ''}${useReporterHighlight ? ' is-reporter-highlight' : ''}${isArmorStandPair ? ' is-armor-stand-pair' : ''}`;
    const iconVisualStyle = useReporterHighlight
      ? `--reporter-accent-color:${color};background:${color};border:2px solid rgba(255,255,255,0.98);box-shadow:0 0 0 1px rgba(15,23,42,.88),0 0 0 3px ${color}42;`
      : `background:${isHorse ? 'rgba(15,23,42,.92)' : (isArmorStandPair ? 'rgba(15,23,42,.88)' : color)};color:${isArmorStandPair ? color : '#ffffff'};border:${isArmorStandPair ? `1.5px solid ${color}` : '1px solid rgba(255,255,255,0.9)'};box-shadow:0 0 0 2px ${color}55,0 0 0 1px rgba(15,23,42,.95) inset;`;
    const iconHtml = showIcon
      ? `<span class="n-icon${iconExtraClass}" style="${iconVisualStyle}width:${iconSize}px;height:${iconSize}px;line-height:${iconSize}px;font-size:${Math.max(9, Math.round(iconSize * 0.75))}px;">${iconContent}</span>`
      : '';
    const teamHtml = CONFIG.SHOW_LABEL_TEAM_INFO && !isHorse && !isArmorStandPair
      ? `<span class="n-team">[${safeTeam}]</span>`
      : '';
    const townHtml = CONFIG.SHOW_LABEL_TOWN_INFO && safeTown
      ? ` <span class="n-town">${safeTown}</span>`
      : '';
    const gapAfterMeta = (teamHtml || safeNote || townHtml || ridingHtml) ? ' ' : '';
    const textHtml = showText
      ? `<span class="n-label" data-align="${showIcon ? 'with-icon' : 'left-anchor'}" style="border-color:${color};box-shadow:0 0 0 1px ${color}55 inset;left:${showIcon ? visual.labelOffset : 0}px;font-size:${visual.textSize}px;">${teamHtml}${safeNote ? `<span class="n-note"> · ${safeNote}</span>` : ''}${townHtml}${ridingHtml}${gapAfterMeta}${safeName}</span>`
      : '';

    return `<div class="nodemc-player-anchor">${iconHtml}${textHtml}</div>`;
  }

  function getMarkerZIndexOffset(markerKind: string) {
    if (markerKind === 'horse') return -1000;
    if (markerKind === 'armor-stand-pair') return 2000;
    return 1000;
  }

  function getWaypointZIndexOffset() {
    return 3000;
  }

  function upsertMarker(map: any, playerId: string, payload: any) {
    const existing = markersById.get(playerId);
    const latLng = worldToLatLng(map, payload.x, payload.z);
    const markerKind = payload.kind || 'player';
    const zIndexOffset = getMarkerZIndexOffset(markerKind);
    const html = buildMarkerHtml(
      payload.name,
      payload.x,
      payload.z,
      payload.health,
      payload.mark,
      payload.townInfo,
      markerKind,
      Boolean(payload.isReporter),
      Boolean(payload.isRiding)
    );

    if (!html) {
      if (existing) {
        existing.remove();
        markersById.delete(playerId);
      }
      return;
    }

    if (existing) {
      try {
        existing.setLatLng(latLng);
        if (typeof existing.setZIndexOffset === 'function') {
          existing.setZIndexOffset(zIndexOffset);
        }
        existing.setIcon(
          leafletRef.divIcon({
            className: '',
            html,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          })
        );
        return;
      } catch (_) {
        try { existing.remove(); } catch (_) {}
        try { markersById.delete(playerId); } catch (_) {}
      }
    }

    const marker = leafletRef.marker(latLng, {
      icon: leafletRef.divIcon({
        className: '',
        html,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      zIndexOffset,
      interactive: false,
      keyboard: false,
    });

    marker.addTo(map);
    markersById.set(playerId, marker);
  }

  function upsertReporterEffects(map: any, playerId: string, payload: any, isReporter: boolean) {
    const existing = reporterEffectsById.get(playerId) || { vision: null, chunkArea: null };

    if (!isReporter || !payload || typeof payload !== 'object') {
      reporterEffectsById.delete(playerId);
      return;
    }

    const team = payload.mark ? normalizeTeam(payload.mark.team) : 'neutral';
    const color = payload.mark
      ? normalizeColor(payload.mark.color, deps.getConfiguredTeamColor(team))
      : deps.getConfiguredTeamColor(team);

    if (Boolean(CONFIG.REPORTER_VISION_CIRCLE_ENABLED)) {
      const radiusBlocks = getReporterVisionRadiusBlocks();
      const circlePath = buildWorldCircleLatLngs(map, payload.x, payload.z, radiusBlocks);
      const visionColor = getReporterEffectColor('REPORTER_VISION_COLOR', color);
      const visionFillOpacity = getReporterVisionOpacity();
      const visionLineOpacity = Math.max(0.25, Math.min(1, visionFillOpacity + 0.45));
      const style = {
        color: visionColor,
        weight: 1.5,
        opacity: visionLineOpacity,
        fillColor: visionColor,
        fillOpacity: visionFillOpacity,
        fillRule: 'nonzero' as const,
        interactive: false as const,
        smoothFactor: 0.5,
      };
      existing.vision = {
        kind: 'vision',
        styleKey: buildReporterEffectStyleKey('vision', style),
        latLngs: circlePath,
        style,
      };
    } else {
      existing.vision = null;
    }

    if (Boolean(CONFIG.REPORTER_CHUNK_AREA_ENABLED)) {
      const chunkRadius = getReporterChunkRadius();
      const areaPath = buildChunkCircleCellsLatLngs(map, payload.x, payload.z, chunkRadius);
      const chunkColor = getReporterEffectColor('REPORTER_CHUNK_COLOR', color);
      const chunkFillOpacity = getReporterChunkOpacity();
      const chunkLineOpacity = Math.max(0.2, Math.min(1, chunkFillOpacity + 0.35));
      const style = {
        color: chunkColor,
        weight: 0.8,
        opacity: chunkLineOpacity,
        fillColor: chunkColor,
        fillOpacity: chunkFillOpacity,
        fillRule: 'nonzero' as const,
        interactive: false as const,
      };
      existing.chunkArea = {
        kind: 'chunkArea',
        styleKey: buildReporterEffectStyleKey('chunkArea', style),
        latLngs: areaPath,
        style,
      };
    } else {
      existing.chunkArea = null;
    }

    if (existing.vision || existing.chunkArea) {
      reporterEffectsById.set(playerId, existing);
      return;
    }
    reporterEffectsById.delete(playerId);
  }

  function buildWaypointHtml(name: string, x: number, z: number, waypoint: any) {
    let safeName = (name && String(name)) ? String(name) : '标点';
    if (CONFIG.SHOW_COORDS) {
      safeName += ` (${Math.round(x)}, ${Math.round(z)})`;
    }
    if (Number.isFinite(waypoint && waypoint.health) && waypoint.health > 0) {
      safeName += ` ❤${Math.round(waypoint.health)}`;
    }

    const color = normalizeColor(waypoint && waypoint.color, '#f97316');
    const owner = (waypoint && (waypoint.ownerName || waypoint.ownerId)) ? (waypoint.ownerName || waypoint.ownerId) : null;
    const visual = getMarkerVisualConfig('waypoint');
    const showIcon = Boolean(CONFIG.SHOW_WAYPOINT_ICON);
    const showText = Boolean(CONFIG.SHOW_WAYPOINT_TEXT);
    if (!showIcon && !showText) return '';

    const ownerHtml = owner ? `<span class="n-wp-owner" style="font-weight:600;display:inline-block;margin-right:6px;">${escapeHtml(String(owner))}</span>` : '';
    const textBg = 'background:rgba(255,255,255,0.85);color:#0f172a;padding:4px 6px;border-radius:6px;display:inline-block;';
    const labelOffset = showIcon ? Math.max(0, Math.round(visual.iconSize / 2) + 6) : 0;

    const textHtml = showText
      ? `<span class="n-waypoint-label" data-align="${showIcon ? 'with-icon' : 'left-anchor'}" style="direction:ltr;white-space:nowrap;left:${labelOffset}px;${textBg};font-size:${visual.textSize}px;">${ownerHtml}${escapeHtml(safeName)}</span>`
      : '';

    const iconHtml = showIcon
      ? `<span class="n-waypoint-icon" style="background:${color};width:${visual.iconSize}px;height:${visual.iconSize}px;line-height:${visual.iconSize}px;font-size:${Math.max(10, Math.round(visual.iconSize * 0.7))}px;z-index:2;">📍</span>`
      : '';

    const safeWaypointId = escapeHtml(String(waypoint && (waypoint.id || waypoint.waypointId) || ''));
    const safeWaypointLabel = escapeHtml(safeName);
    return `<div class="nodemc-waypoint-anchor" data-nodemc-waypoint-id="${safeWaypointId}" data-nodemc-waypoint-label="${safeWaypointLabel}">${iconHtml}${textHtml}</div>`;
  }

  function upsertWaypoint(map: any, waypointId: string, payload: any) {
    const existing = waypointsById.get(waypointId);
    if (!payload || typeof payload !== 'object') return;
    const latLng = worldToLatLng(map, payload.x, payload.z);
    const zIndexOffset = getWaypointZIndexOffset();
    const html = buildWaypointHtml(payload.label || payload.name || waypointId, payload.x, payload.z, payload);

    if (!html) {
      if (existing) {
        existing.remove();
        waypointsById.delete(waypointId);
      }
      return;
    }

    if (existing) {
      try {
        existing.setLatLng(latLng);
        if (typeof existing.setZIndexOffset === 'function') {
          existing.setZIndexOffset(zIndexOffset);
        }
        existing.setIcon(
          leafletRef.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] })
        );
        return;
      } catch (_) {
        try { existing.remove(); } catch (_) {}
        try { waypointsById.delete(waypointId); } catch (_) {}
      }
    }

    const marker = leafletRef.marker(latLng, {
      icon: leafletRef.divIcon({ className: '', html, iconSize: [0, 0], iconAnchor: [0, 0] }),
      zIndexOffset,
      interactive: true,
      keyboard: false,
    });

    marker.addTo(map);
    waypointsById.set(waypointId, marker);
  }

  function upsertBattleChunk(map: any, chunkId: string, payload: any) {
    if (!payload || typeof payload !== 'object' || !Boolean(CONFIG.SHOW_BATTLE_CHUNK_LAYER)) {
      const existing = battleChunkLayersById.get(chunkId);
      if (existing) {
        try { existing.remove(); } catch (_) {}
        battleChunkLayersById.delete(chunkId);
      }
      return;
    }

    const chunkX = readNumber(payload.chunkX);
    const chunkZ = readNumber(payload.chunkZ);
    if (chunkX === null || chunkZ === null) {
      return;
    }

    const { style, renderMode } = buildBattleChunkStyle(payload);
    const bounds = buildBattleChunkBounds(map, Math.floor(chunkX), Math.floor(chunkZ));
    const existing = battleChunkLayersById.get(chunkId);
    const payloadWithRenderMode = { ...payload, renderMode };

    if (existing) {
      try {
        existing.setBounds(bounds);
        existing.setStyle(style);
        if (shouldShowBattleChunkDebug()) {
          const tooltipHtml = buildBattleChunkTooltip(chunkId, payloadWithRenderMode);
          if (typeof existing.bindTooltip === 'function') {
            existing.bindTooltip(tooltipHtml, { sticky: true, direction: 'top', opacity: 0.95 });
          }
        } else if (typeof existing.unbindTooltip === 'function') {
          existing.unbindTooltip();
        }
        return;
      } catch (_) {
        try { existing.remove(); } catch (_) {}
        battleChunkLayersById.delete(chunkId);
      }
    }

    const layer = leafletRef.rectangle(bounds, style);
    if (shouldShowBattleChunkDebug() && typeof layer.bindTooltip === 'function') {
      layer.bindTooltip(buildBattleChunkTooltip(chunkId, payloadWithRenderMode), { sticky: true, direction: 'top', opacity: 0.95 });
    }
    layer.addTo(map);
    battleChunkLayersById.set(chunkId, layer);
  }

  function removeMissingMarkers(nextIds: Set<string>) {
    for (const [playerId, marker] of markersById.entries()) {
      if (nextIds.has(playerId)) continue;
      marker.remove();
      markersById.delete(playerId);
    }
  }

  function removeMissingWaypoints(nextIds: Set<string>) {
    for (const [wpId, marker] of waypointsById.entries()) {
      if (nextIds.has(wpId)) continue;
      try { marker.remove(); } catch (_) {}
      waypointsById.delete(wpId);
      trackedWaypointPositions.delete(wpId);
    }
  }

  function removeMissingBattleChunks(nextIds: Set<string>) {
    for (const [chunkId, layer] of battleChunkLayersById.entries()) {
      if (nextIds.has(chunkId)) continue;
      try { layer.remove(); } catch (_) {}
      battleChunkLayersById.delete(chunkId);
    }
  }

  function findTrackedPositionFromEntities(snapshot: any, targetEntityId: string, wantedDim: string) {
    const entities = snapshot && typeof snapshot === 'object' ? snapshot.entities : null;
    if (!entities || typeof entities !== 'object') return null;

    const rawNode = (entities as Record<string, any>)[targetEntityId];
    if (!rawNode) return null;
    const data = getPlayerDataNode(rawNode);
    if (!data) return null;

    const dim = normalizeDimension(data.dimension);
    if (wantedDim && dim !== wantedDim) return null;

    const x = readNumber(data.x);
    const z = readNumber(data.z);
    if (x === null || z === null) return null;
    return { x, z };
  }

  function findTrackedPositionFromPlayers(snapshot: any, targetEntityId: string, wantedDim: string) {
    const players = snapshot && typeof snapshot === 'object' ? snapshot.players : null;
    if (!players || typeof players !== 'object') return null;

    const normalizedTargetId = String(targetEntityId || '').trim();
    if (!normalizedTargetId) return null;

    for (const [playerId, rawNode] of Object.entries(players as Record<string, any>)) {
      const data = getPlayerDataNode(rawNode);
      if (!data) continue;

      const candidateIds = [
        String(playerId || '').trim(),
        String(data.playerUUID || data.uuid || data.id || '').trim(),
      ];
      if (!candidateIds.includes(normalizedTargetId)) continue;

      const dim = normalizeDimension(data.dimension);
      if (wantedDim && dim !== wantedDim) continue;

      const x = readNumber(data.x);
      const z = readNumber(data.z);
      if (x === null || z === null) continue;
      return { x, z };
    }

    return null;
  }

  function resolveWaypointTrackedPosition(snapshot: any, waypointId: string, data: any, wantedDim: string) {
    const fallbackX = readNumber(data.x);
    const fallbackZ = readNumber(data.z);
    if (fallbackX === null || fallbackZ === null) return null;

    const targetType = String(data.targetType || '').trim().toLowerCase();
    const targetEntityId = String(data.targetEntityId || '').trim();
    if (targetType !== 'entity' || !targetEntityId) {
      const base = { x: fallbackX, z: fallbackZ };
      trackedWaypointPositions.set(waypointId, base);
      return base;
    }

    const entityPos = findTrackedPositionFromEntities(snapshot, targetEntityId, wantedDim);
    if (entityPos) {
      trackedWaypointPositions.set(waypointId, entityPos);
      return entityPos;
    }

    const playerPos = findTrackedPositionFromPlayers(snapshot, targetEntityId, wantedDim);
    if (playerPos) {
      trackedWaypointPositions.set(waypointId, playerPos);
      return playerPos;
    }

    const lastPos = trackedWaypointPositions.get(waypointId);
    if (lastPos) return lastPos;

    const initial = { x: fallbackX, z: fallbackZ };
    trackedWaypointPositions.set(waypointId, initial);
    return initial;
  }

  function removeMissingReporterEffects(nextIds: Set<string>) {
    for (const [playerId, layers] of reporterEffectsById.entries()) {
      if (nextIds.has(playerId)) continue;
      reporterEffectsById.delete(playerId);
    }
  }

  function applySnapshotPlayers(map: any, snapshot: any) {
    const players = snapshot && typeof snapshot === 'object' ? snapshot.players : null;
    const wantedDim = normalizeDimension(CONFIG.TARGET_DIMENSION);
    const nextIds = new Set<string>();
    const nextPlayerIds = new Set<string>();
    const autoMarkSyncCandidates: any[] = [];
    const reporterIdentities = getReportingPlayerIdentities(snapshot);

    if (players && typeof players === 'object') {
      for (const [playerId, rawNode] of Object.entries(players)) {
        const data = getPlayerDataNode(rawNode);
        if (!data) continue;

        const dim = normalizeDimension(data.dimension);
        if (wantedDim && dim !== wantedDim) continue;

        const x = readNumber(data.x);
        const z = readNumber(data.z);
        if (x === null || z === null) continue;

        const health = readNumber(data.health);
        const name = String(data.playerName || data.playerUUID || playerId);
        const existingMark = deps.getPlayerMark(String(playerId));
        const tabInfo = deps.getTabPlayerInfo(String(playerId));
        const autoName = deps.getTabPlayerName(String(playerId)) || name;
        // 优先使用包含城镇信息的显示名进行自动标记识别
        const displayNameForAutoMark = (tabInfo && tabInfo.teamText) ? `[${tabInfo.teamText}] ${autoName}` : autoName;
        const autoMark = deps.autoTeamFromName(displayNameForAutoMark);
        const existingMarkSource = existingMark ? normalizeMarkSource(existingMark.source) : 'manual';
        const existingActsAsAuto = Boolean(existingMark) && existingMarkSource === 'auto';
        const isManualMark = Boolean(existingMark) && !existingActsAsAuto;

        if (isManualMark) {
          // best-effort: keep auto cache clean via clear candidate logic
        }

        if (!isManualMark) {
          if (autoMark && (autoMark.team === 'friendly' || autoMark.team === 'enemy')) {
            const desiredTeam = normalizeTeam(autoMark.team);
            const desiredColor = normalizeColor(autoMark.color, deps.getConfiguredTeamColor(desiredTeam));
            const hasSameAutoMark = Boolean(existingMark)
              && existingActsAsAuto
              && normalizeTeam(existingMark.team) === desiredTeam
              && normalizeColor(existingMark.color, deps.getConfiguredTeamColor(desiredTeam)) === desiredColor;

            if (!hasSameAutoMark) {
              autoMarkSyncCandidates.push({
                action: 'set',
                playerId,
                team: desiredTeam,
                color: desiredColor,
              });
            }
          } else if (existingActsAsAuto) {
            autoMarkSyncCandidates.push({
              action: 'clear',
              playerId,
            });
          }
        }

        const effectiveMark = isManualMark
          ? existingMark
          : (autoMark || (existingActsAsAuto ? null : existingMark));

        const townInfo = tabInfo && tabInfo.teamText
          ? {
              text: tabInfo.teamText,
              color: tabInfo.teamColor || null,
            }
          : null;
        const isReporter = isReportingPlayer(String(playerId), rawNode, data, reporterIdentities);
        const isRiding = parseBooleanFlag((data as any).isRiding);

        nextIds.add(String(playerId));
        nextPlayerIds.add(String(playerId));
        upsertMarker(map, String(playerId), { x, z, health, name, mark: effectiveMark, townInfo, isReporter, isRiding });
        try {
          upsertReporterEffects(map, String(playerId), { x, z, mark: effectiveMark }, isReporter);
        } catch (_) {
        }
      }
    }

    const entities = snapshot && typeof snapshot === 'object' ? snapshot.entities : null;
    if (CONFIG.SHOW_HORSE_ENTITIES && entities && typeof entities === 'object') {
      for (const [entityId, rawNode] of Object.entries(entities)) {
        const data = getPlayerDataNode(rawNode);
        if (!data) continue;

        const entityType = String(data.entityType || '').toLowerCase();
        if (!entityType.includes('horse')) continue;

        const dim = normalizeDimension(data.dimension);
        if (wantedDim && dim !== wantedDim) continue;

        const x = readNumber(data.x);
        const z = readNumber(data.z);
        if (x === null || z === null) continue;

        const markerId = `entity:${entityId}`;
        const entityName = String(data.entityName || '马').trim() || '马';
        nextIds.add(markerId);
        upsertMarker(map, markerId, {
          x,
          z,
          health: null,
          name: entityName,
          mark: {
            team: 'neutral',
            color: deps.getConfiguredTeamColor('neutral'),
            label: '',
          },
          townInfo: null,
          kind: 'horse',
        });
      }
    }

    if (Boolean(CONFIG.SHOW_CAPTURE_INFO)) {
      for (const armorStandPair of collectRenderableArmorStandPairs(snapshot, wantedDim)) {
        nextIds.add(armorStandPair.markerId);
        upsertMarker(map, armorStandPair.markerId, {
          x: armorStandPair.x,
          z: armorStandPair.z,
          health: null,
          name: armorStandPair.name,
          mark: {
            team: 'neutral',
            color: armorStandPair.color,
            label: '',
          },
          townInfo: null,
          kind: 'armor-stand-pair',
        });
      }
    }

    const waypoints = snapshot && typeof snapshot === 'object' ? snapshot.waypoints : null;
    const nextWaypointIds = new Set<string>();
    if (waypoints && typeof waypoints === 'object') {
      for (const [wpId, rawNode] of Object.entries(waypoints)) {
        if (!rawNode) continue;
        const data = (rawNode as any).data && typeof (rawNode as any).data === 'object' ? (rawNode as any).data : rawNode;
        if (!data) continue;

        const dim = normalizeDimension((data as any).dimension);
        if (wantedDim && dim !== wantedDim) continue;

        const resolvedPos = resolveWaypointTrackedPosition(snapshot, String(wpId), data, wantedDim);
        if (!resolvedPos) continue;

        nextWaypointIds.add(String(wpId));
        upsertWaypoint(map, String(wpId), {
          id: String(wpId),
          x: resolvedPos.x,
          z: resolvedPos.z,
          label: (data as any).label || (data as any).name || (data as any).title || String(wpId),
          color: (data as any).color || ((data as any).colorHex ? (data as any).colorHex : null) || null,
          kind: (data as any).waypointKind || null,
          ownerName: (data as any).ownerName || null,
          ownerId: (data as any).ownerId || null,
          targetType: (data as any).targetType || null,
          targetEntityId: (data as any).targetEntityId || null,
        });
      }
    }

    const battleChunks = snapshot && typeof snapshot === 'object' ? snapshot.battleChunks : null;
    const nextBattleChunkIds = new Set<string>();
    if (battleChunks && typeof battleChunks === 'object' && Boolean(CONFIG.SHOW_BATTLE_CHUNK_LAYER)) {
      for (const [chunkId, rawNode] of Object.entries(battleChunks)) {
        if (!rawNode || typeof rawNode !== 'object') continue;
        const data = (rawNode as any).data && typeof (rawNode as any).data === 'object' ? (rawNode as any).data : rawNode;
        const dim = normalizeDimension((data as any).dimension);
        if (wantedDim && dim !== wantedDim) continue;

        const chunkX = readNumber((data as any).chunkX);
        const chunkZ = readNumber((data as any).chunkZ);
        if (chunkX === null || chunkZ === null) continue;
        const symbol = String((data as any).symbol || '').trim();
        if (symbol === '┼') continue;

        nextBattleChunkIds.add(String(chunkId));
        upsertBattleChunk(map, String(chunkId), {
          chunkX,
          chunkZ,
          dimension: dim,
          symbol,
          markerType: (data as any).markerType || '',
          colorRaw: (data as any).colorRaw || '',
          colorNote: (data as any).colorNote || '',
          observedAt: (data as any).observedAt || null,
          positionSampledAt: (data as any).positionSampledAt || null,
          alignmentSource: (data as any).alignmentSource || '',
        });
      }
    }

    removeMissingMarkers(nextIds);
    removeMissingWaypoints(nextWaypointIds);
    removeMissingBattleChunks(nextBattleChunkIds);
    removeMissingReporterEffects(nextPlayerIds);
    rebuildReporterEffectLayers(map);
    deps.maybeSyncAutoDetectedMarks(autoMarkSyncCandidates);

    const overlayState = {
      playersOnMap: markersById.size,
      waypointsOnMap: waypointsById.size,
      battleChunksOnMap: battleChunkLayersById.size,
      source: CONFIG.ADMIN_WS_URL,
      dimension: CONFIG.TARGET_DIMENSION,
      wsConnected: deps.getWsConnected(),
      playerMarks: deps.getLatestPlayerMarks(),
    };
    (PAGE as any).__TEAM_VIEW_RELAY_OVERLAY__ = overlayState;
    (PAGE as any).__NODEMC_PLAYER_OVERLAY__ = overlayState;
  }

  function isMapReady() {
    const map = capturedMap || findMapByDom();
    ensureMapInteractionGuard();
    if (!map || !leafletRef || !map._loaded) {
      return false;
    }
    if (map._container && map._container.isConnected === false) {
      if (capturedMap === map) {
        capturedMap = null;
      }
      return false;
    }
    return true;
  }

  function applyLatestSnapshotIfPossible(snapshot: any) {
    if (!snapshot) return false;
    ensureOverlayStyles();
    const map = capturedMap || findMapByDom();
    ensureMapInteractionGuard();
    if (!map || !leafletRef || !map._loaded) return false;
    applySnapshotPlayers(map, snapshot);
    return true;
  }

  function focusOnWorldPosition(x: number, z: number) {
    const map = capturedMap || findMapByDom();
    if (!map || !leafletRef || !map._loaded) return false;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;

    const target = worldToLatLng(map, x, z);
    try {
      if (typeof map.panTo === 'function') {
        map.panTo(target, { animate: true, duration: 0.35 });
      } else if (typeof map.setView === 'function') {
        const zoom = typeof map.getZoom === 'function' ? map.getZoom() : undefined;
        map.setView(target, zoom, { animate: true, duration: 0.35 });
      } else {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function getCounts() {
    return {
      markers: markersById.size,
      waypoints: waypointsById.size,
      battleChunks: battleChunkLayersById.size,
    };
  }

  function cleanup() {
    closeTacticalMenu();
    detachMapInteractionGuard();
    detachMapHoverPopupBlock();

    for (const m of markersById.values()) {
      try { m.remove(); } catch (_) {}
    }
    markersById.clear();

    for (const m of waypointsById.values()) {
      try { m.remove(); } catch (_) {}
    }
    waypointsById.clear();

    for (const layer of battleChunkLayersById.values()) {
      try { layer.remove(); } catch (_) {}
    }
    battleChunkLayersById.clear();

    for (const layer of reporterEffectLayersByStyle.values()) {
      try { layer.remove(); } catch (_) {}
    }
    reporterEffectLayersByStyle.clear();
    reporterEffectsById.clear();

    try {
      const blockStyle = document.getElementById('nodemc-map-hover-popup-style');
      if (blockStyle) blockStyle.remove();
    } catch (_) {}
  }

  return {
    ensureOverlayStyles,
    installLeafletHook,
    findMapByDom,
    ensureMapInteractionGuard,
    isMapReady,
    applyLatestSnapshotIfPossible,
    focusOnWorldPosition,
    getCounts,
    cleanup,
  };
}
