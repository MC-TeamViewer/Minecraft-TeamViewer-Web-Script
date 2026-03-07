<script setup lang="ts">
import { computed, ref } from 'vue';

type PlayerOption = {
  playerId: string;
  playerName: string;
  displayLabel: string;
  teamColor: string | null;
};

type MapPlayerListItem = {
  playerId: string;
  playerName: string;
  team: string;
  teamColor: string;
  town: string;
  townColor: string;
  health: string;
  armor: string;
};

type OverviewState = {
  wsConnected: boolean;
  hasError: boolean;
  markerCount: number;
  onlinePlayerCount: number;
  mapPlayerCount: number;
  roomCode: string;
  targetDimension: string;
};

type OverlayUiState = {
  page: 'main' | 'advanced' | 'display' | 'mark' | 'connection' | 'help';
  statusText: string;
  overview: OverviewState;
  dirty: {
    mainText: boolean;
    connection: boolean;
    displayInputs: boolean;
  };
  sameServerFilterEnabled: boolean;
  players: PlayerOption[];
  mapPlayers: MapPlayerListItem[];
  selectedPlayerId: string;
  playerListVisible: boolean;
  mark: {
    team: string;
    color: string;
    label: string;
  };
  form: {
    ADMIN_WS_URL: string;
    ROOM_CODE: string;
    RECONNECT_INTERVAL_MS: string;
    TARGET_DIMENSION: string;
    SHOW_PLAYER_ICON: boolean;
    SHOW_PLAYER_TEXT: boolean;
    SHOW_HORSE_TEXT: boolean;
    SHOW_HORSE_ENTITIES: boolean;
    SHOW_LABEL_TEAM_INFO: boolean;
    SHOW_LABEL_TOWN_INFO: boolean;
    BLOCK_MAP_LEFT_RIGHT_CLICK: boolean;
    ENABLE_TACTICAL_MAP_MARKING: boolean;
    TACTICAL_MARK_DEFAULT_TTL_SECONDS: string;
    BLOCK_MAP_HOVER_POPUP: boolean;
    PLAYER_ICON_SIZE: string;
    PLAYER_TEXT_SIZE: string;
    HORSE_ICON_SIZE: string;
    HORSE_TEXT_SIZE: string;
    SHOW_COORDS: boolean;
    REPORTER_STAR_ICON: boolean;
    REPORTER_VISION_CIRCLE_ENABLED: boolean;
    REPORTER_VISION_RADIUS: string;
    REPORTER_EFFECT_COLOR: string;
    REPORTER_VISION_OPACITY: string;
    REPORTER_CHUNK_AREA_ENABLED: boolean;
    REPORTER_CHUNK_RADIUS: string;
    REPORTER_CHUNK_OPACITY: string;
    AUTO_TEAM_FROM_NAME: boolean;
    FRIENDLY_TAGS: string;
    ENEMY_TAGS: string;
    TEAM_COLOR_FRIENDLY: string;
    TEAM_COLOR_NEUTRAL: string;
    TEAM_COLOR_ENEMY: string;
    SHOW_WAYPOINT_ICON: boolean;
    SHOW_WAYPOINT_TEXT: boolean;
    DEBUG: boolean;
  };
};

type OverlayUiActions = {
  onAutoApply: () => void;
  onSave: () => void;
  onSaveAdvanced: () => void;
  onSaveDisplay: () => void;
  onExportConfig: () => void;
  onImportConfig: () => void;
  onReset: () => void;
  onRefresh: () => void;
  onMarkApply: () => void;
  onMarkClear: () => void;
  onMarkClearAll: () => void;
  onServerFilterToggle: (enabled: boolean) => void;
  onTeamChanged: (team: string) => void;
  onPlayerSelectionChanged: () => void;
  onTogglePlayerList: (visible: boolean) => void;
  onFocusMapPlayer: (playerId: string) => void;
};

const props = defineProps<{
  state: OverlayUiState;
  actions: OverlayUiActions;
  getPlayerOptionColor?: (item: PlayerOption) => string | null;
}>();

const primaryTabs: Array<{ page: 'main' | 'advanced'; label: string }> = [
  { page: 'main', label: '概览' },
  { page: 'advanced', label: '高级' },
];

const quickLabels = ['侦查', '重点观察', '突击组', '运输', '危险'];

const hasPlayers = computed(() => props.state.players.length > 0);
const hasMapPlayers = computed(() => props.state.mapPlayers.length > 0);
const quickPlayers = computed(() => props.state.players.slice(0, 8));
const configMenuVisible = ref(false);

const statusToneClass = computed(() => {
  if (props.state.overview.hasError) return 'is-error';
  if (props.state.overview.wsConnected) return 'is-ok';
  return 'is-idle';
});

const statusTitle = computed(() => {
  if (props.state.overview.hasError) return '需要处理';
  if (props.state.overview.wsConnected) return '运行中';
  return '待连接';
});

function setPage(nextPage: OverlayUiState['page']) {
  configMenuVisible.value = false;
  props.state.page = nextPage;
}

function getOptionColor(item: PlayerOption) {
  return props.getPlayerOptionColor ? props.getPlayerOptionColor(item) : item.teamColor;
}

function onTeamChanged() {
  props.actions.onTeamChanged(String(props.state.mark.team || 'neutral'));
}

function onServerFilterChange() {
  props.actions.onServerFilterToggle(Boolean(props.state.sameServerFilterEnabled));
}

function onPlayerSelectionChanged() {
  props.actions.onPlayerSelectionChanged();
}

function triggerAutoApply() {
  props.actions.onAutoApply();
}

function markMainTextDirty() {
  props.state.dirty.mainText = true;
}

function markConnectionDirty() {
  props.state.dirty.connection = true;
}

function markDisplayInputsDirty() {
  props.state.dirty.displayInputs = true;
}

function saveMainText() {
  props.actions.onSave();
  props.state.dirty.mainText = false;
}

function saveConnectionSettings() {
  props.actions.onSaveAdvanced();
  props.state.dirty.connection = false;
}

function saveDisplayInputs() {
  props.actions.onSaveDisplay();
  props.state.dirty.displayInputs = false;
}

function togglePlayerList() {
  props.actions.onTogglePlayerList(!props.state.playerListVisible);
}

function closePlayerList() {
  props.actions.onTogglePlayerList(false);
}

function focusMapPlayer(playerId: string) {
  props.actions.onFocusMapPlayer(playerId);
}

function toggleConfigMenu() {
  configMenuVisible.value = !configMenuVisible.value;
}

function onResetFromMenu() {
  props.actions.onReset();
  configMenuVisible.value = false;
}

function onExportConfigFromMenu() {
  props.actions.onExportConfig();
  configMenuVisible.value = false;
}

function onImportConfigFromMenu() {
  props.actions.onImportConfig();
  configMenuVisible.value = false;
}

function selectPlayer(playerId: string) {
  props.state.selectedPlayerId = playerId;
  onPlayerSelectionChanged();
}

function applyTeamPreset(team: string) {
  props.state.mark.team = team;
  onTeamChanged();
}

function applyQuickLabel(label: string) {
  props.state.mark.label = label;
}
</script>

<template>
  <div class="n-header" id="nodemc-overlay-title">
    <div class="n-header-top">
      <div class="n-overview-copy">
        <div class="n-eyebrow">当前工作区</div>
        <div class="n-hero-title">{{ statusTitle }}</div>
      </div>
      <div class="n-status-pill" :class="statusToneClass">{{ state.overview.wsConnected ? 'WS 已连接' : 'WS 未连接' }}</div>
    </div>
    <div class="n-hero-text">{{ state.statusText }}</div>
  </div>

  <div class="n-primary-tabs">
    <button
      v-for="tab in primaryTabs"
      :id="`nodemc-overlay-tab-${tab.page}`"
      :key="tab.page"
      type="button"
      class="n-tab-btn"
      :class="{ active: state.page === tab.page }"
      @click="setPage(tab.page)"
    >
      {{ tab.label }}
    </button>
  </div>

  <div class="n-page" :class="{ active: state.page === 'main' }" id="nodemc-overlay-page-main">
    <div class="n-metric-grid">
      <div class="n-metric-card">
        <div class="n-metric-label">房间号</div>
        <div class="n-metric-value">{{ state.overview.roomCode || 'default' }}</div>
      </div>
      <div class="n-metric-card">
        <div class="n-metric-label">在线玩家</div>
        <div class="n-metric-value">{{ state.overview.onlinePlayerCount }}</div>
      </div>
      <div class="n-metric-card">
        <div class="n-metric-label">地图可见玩家</div>
        <div class="n-metric-value">{{ state.overview.mapPlayerCount }}</div>
      </div>
      <div class="n-metric-card">
        <div class="n-metric-label">地图标注数</div>
        <div class="n-metric-value">{{ state.overview.markerCount }}</div>
      </div>
    </div>

    <div class="n-card n-overview-card">
      <div class="n-section-header">
        <div>
          <div class="n-subtitle">快捷操作</div>
        </div>
        <button id="nodemc-overlay-open-config-menu" type="button" class="n-btn-ghost" @click="toggleConfigMenu">
          {{ configMenuVisible ? '收起工具' : '配置工具' }}
        </button>
      </div>

      <div class="n-quick-grid">
        <button id="nodemc-overlay-open-connection" type="button" class="n-link-btn n-quick-action" @click="setPage('connection')">
          <span>连接设置</span>
          <small>URL / 房间 / 重连</small>
        </button>
        <button id="nodemc-overlay-open-mark" type="button" class="n-link-btn n-quick-action" @click="setPage('mark')">
          <span>玩家标记</span>
          <small>集中处理选人、阵营和标签</small>
        </button>
        <button id="nodemc-overlay-open-display" type="button" class="n-link-btn n-quick-action" @click="setPage('display')">
          <span>显示设置</span>
          <small>统一调整图标、文字、颜色和高亮效果</small>
        </button>
        <button id="nodemc-overlay-open-player-list" type="button" class="n-link-btn n-quick-action" @click="togglePlayerList">
          <span>地图玩家列表</span>
          <small>{{ hasMapPlayers ? '点击查看并聚焦目标' : '当前暂无地图玩家' }}</small>
        </button>
        <button id="nodemc-overlay-refresh" type="button" class="n-link-btn n-quick-action" @click="actions.onRefresh">
          <span>立即重连</span>
          <small>用于连接异常或切服后刷新</small>
        </button>
        <button id="nodemc-overlay-open-help" type="button" class="n-link-btn n-quick-action" @click="setPage('help')">
          <span>使用帮助</span>
          <small>首次接入和排错流程</small>
        </button>
      </div>

      <div v-if="configMenuVisible" class="n-config-menu" id="nodemc-overlay-config-menu">
        <div class="n-btns n-config-menu-items">
          <button id="nodemc-overlay-reset" type="button" class="n-btn-ghost" @click="onResetFromMenu">重置</button>
          <button id="nodemc-overlay-export-config" type="button" class="n-btn-ghost" @click="onExportConfigFromMenu">导出配置</button>
          <button id="nodemc-overlay-import-config" type="button" class="n-btn-ghost" @click="onImportConfigFromMenu">导入配置</button>
        </div>
      </div>
    </div>

    <div v-if="state.playerListVisible" class="n-player-list-popup" id="nodemc-overlay-player-list-popup">
      <div class="n-player-list-header">
        <div class="n-player-list-title">地图玩家列表</div>
        <button id="nodemc-overlay-close-player-list" type="button" class="n-player-list-close" @click="closePlayerList">关闭</button>
      </div>
      <div class="n-player-list-table-wrap">
        <table class="n-player-list-table">
          <thead>
            <tr>
              <th>玩家名称</th>
              <th>阵营</th>
              <th>城镇</th>
              <th>血量</th>
              <th>盔甲值</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in state.mapPlayers"
              :key="item.playerId"
              class="n-player-list-row"
              @click="focusMapPlayer(item.playerId)"
            >
              <td>{{ item.playerName }}</td>
              <td>
                <span class="n-team-chip" :style="{ color: item.teamColor, borderColor: `${item.teamColor}66`, background: `${item.teamColor}20` }">
                  {{ item.team }}
                </span>
              </td>
              <td>
                <span class="n-town-chip" :style="{ color: item.townColor, borderColor: `${item.townColor}66`, background: `${item.townColor}1f` }">
                  {{ item.town }}
                </span>
              </td>
              <td>{{ item.health }}</td>
              <td>{{ item.armor }}</td>
            </tr>
            <tr v-if="!hasMapPlayers">
              <td colspan="5" class="n-player-list-empty">当前地图暂无可显示玩家</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="n-page" :class="{ active: state.page === 'mark' }" id="nodemc-overlay-page-mark">
    <div class="n-nav-row">
      <div>
        <div class="n-subtitle" style="margin: 0">玩家标记</div>
      </div>
      <button id="nodemc-overlay-back-main-from-mark" type="button" class="n-link-btn" @click="setPage('main')">返回概览</button>
    </div>

    <div class="n-card">
      <div class="n-subtitle">目标玩家</div>
      <div class="n-row full-width">
        <label>在线玩家列表</label>
        <select id="nodemc-mark-player-select" v-model="state.selectedPlayerId" @change="onPlayerSelectionChanged">
          <option value="">{{ hasPlayers ? '请选择在线玩家…' : '暂无在线玩家' }}</option>
          <option
            v-for="item in state.players"
            :key="item.playerId"
            :value="item.playerId"
            :style="{ color: getOptionColor(item) || undefined }"
          >
            {{ item.displayLabel || item.playerName }}
          </option>
        </select>
      </div>
      <div v-if="quickPlayers.length > 0" class="n-chip-list full-width">
        <button
          v-for="item in quickPlayers"
          :key="item.playerId"
          type="button"
          class="n-chip-btn"
          :class="{ active: state.selectedPlayerId === item.playerId }"
          @click="selectPlayer(item.playerId)"
        >
          {{ item.playerName }}
        </button>
      </div>
      <div class="n-segmented full-width">
        <button type="button" class="n-segment-btn is-friendly" :class="{ active: state.mark.team === 'friendly' }" @click="applyTeamPreset('friendly')">友军</button>
        <button type="button" class="n-segment-btn is-neutral" :class="{ active: state.mark.team === 'neutral' }" @click="applyTeamPreset('neutral')">中立</button>
        <button type="button" class="n-segment-btn is-enemy" :class="{ active: state.mark.team === 'enemy' }" @click="applyTeamPreset('enemy')">敌军</button>
      </div>
      <div class="n-row">
        <label>颜色(#RRGGBB)</label>
        <div class="n-color-input-wrap">
          <span class="n-color-swatch" :style="{ background: state.mark.color || '#94a3b8' }"></span>
          <input id="nodemc-mark-color-advanced" v-model="state.mark.color" type="text" placeholder="#ef4444" />
        </div>
      </div>
      <div class="n-row">
        <label>标签(可选)</label>
        <input id="nodemc-mark-label-advanced" v-model="state.mark.label" type="text" placeholder="例如：突击组 / 重点观察" />
      </div>
      <div class="n-chip-list full-width">
        <button v-for="label in quickLabels" :key="label" type="button" class="n-chip-btn" @click="applyQuickLabel(label)">{{ label }}</button>
      </div>
      <div class="n-btns">
        <button id="nodemc-mark-apply" type="button" class="n-btn-primary" @click="actions.onMarkApply">应用标记</button>
        <button id="nodemc-mark-clear" type="button" class="n-btn-ghost" @click="actions.onMarkClear">清除该玩家</button>
        <button id="nodemc-mark-clear-all" type="button" class="n-btn-danger" @click="actions.onMarkClearAll">清空全部标记</button>
      </div>
    </div>

    <div class="n-card">
      <div class="n-subtitle">自动识别标签</div>
      <div class="n-row">
        <label>友军标签（逗号分隔，按游戏中的前缀识别）</label>
        <input v-model="state.form.FRIENDLY_TAGS" @input="markMainTextDirty" id="nodemc-overlay-friendly-tags" type="text" placeholder="[xxx],[队友]" />
      </div>
      <div class="n-row">
        <label>敌军标签（逗号分隔，按游戏中的前缀识别）</label>
        <input v-model="state.form.ENEMY_TAGS" @input="markMainTextDirty" id="nodemc-overlay-enemy-tags" type="text" placeholder="[yyy],[红队]" />
      </div>
      <label class="n-check full-width"><input v-model="state.form.AUTO_TEAM_FROM_NAME" @change="triggerAutoApply" id="nodemc-overlay-auto-team" type="checkbox" />按名字标签自动判定友敌</label>
      <div class="n-btns">
        <button id="nodemc-overlay-save" type="button" class="n-btn-primary" :disabled="!state.dirty.mainText" @click="saveMainText">保存识别规则</button>
      </div>
      <div v-if="state.dirty.mainText" class="n-dirty-hint">标签规则已修改，点击“保存识别规则”后生效</div>
    </div>
  </div>

  <div class="n-page" :class="{ active: state.page === 'display' }" id="nodemc-overlay-page-display">
    <div class="n-nav-row">
      <div>
        <div class="n-subtitle" style="margin: 0">显示设置</div>
        <div class="n-section-copy">把尺寸、颜色和特殊显示集中在一页处理</div>
      </div>
      <button id="nodemc-overlay-back-main-from-display" type="button" class="n-link-btn" @click="setPage('main')">返回概览</button>
    </div>

    <div class="n-card">
      <div class="n-subtitle">显示开关</div>
      <label class="n-check"><input v-model="state.form.SHOW_PLAYER_ICON" @change="triggerAutoApply" id="nodemc-overlay-show-icon" type="checkbox" />显示玩家图标（图标中心对准玩家坐标）</label>
      <label class="n-check"><input v-model="state.form.SHOW_PLAYER_TEXT" @change="triggerAutoApply" id="nodemc-overlay-show-text" type="checkbox" />显示玩家文字信息（仅文字时左端对准玩家坐标）</label>
      <label class="n-check"><input v-model="state.form.SHOW_WAYPOINT_ICON" @change="triggerAutoApply" id="nodemc-overlay-show-waypoint-icon" type="checkbox" />显示报点图标（图标中心对准报点坐标）</label>
      <label class="n-check"><input v-model="state.form.SHOW_WAYPOINT_TEXT" @change="triggerAutoApply" id="nodemc-overlay-show-waypoint-text" type="checkbox" />显示报点文字（文字左端对准报点坐标，带浅色半透明背景）</label>
      <label class="n-check"><input v-model="state.form.SHOW_HORSE_ENTITIES" @change="triggerAutoApply" id="nodemc-overlay-show-horse-entities" type="checkbox" />是否显示马实体</label>
      <label class="n-check"><input v-model="state.form.SHOW_HORSE_TEXT" @change="triggerAutoApply" id="nodemc-overlay-show-horse-text" type="checkbox" />显示马文字信息</label>
      <label class="n-check"><input v-model="state.form.SHOW_LABEL_TEAM_INFO" @change="triggerAutoApply" id="nodemc-overlay-show-team-info" type="checkbox" />地图文字显示阵营信息</label>
      <label class="n-check"><input v-model="state.form.SHOW_LABEL_TOWN_INFO" @change="triggerAutoApply" id="nodemc-overlay-show-town-info" type="checkbox" />地图文字显示城镇信息</label>
      <label class="n-check"><input v-model="state.form.SHOW_COORDS" @change="triggerAutoApply" id="nodemc-overlay-coords" type="checkbox" />显示坐标</label>
    </div>

    <div class="n-card">
      <div class="n-subtitle">大小设置</div>
      <div class="n-row">
        <label>玩家图标大小(px)</label>
        <input v-model="state.form.PLAYER_ICON_SIZE" @input="markDisplayInputsDirty" id="nodemc-overlay-player-icon-size" type="number" min="6" max="40" step="1" />
      </div>
      <div class="n-row">
        <label>玩家文字大小(px)</label>
        <input v-model="state.form.PLAYER_TEXT_SIZE" @input="markDisplayInputsDirty" id="nodemc-overlay-player-text-size" type="number" min="8" max="32" step="1" />
      </div>
      <div class="n-row">
        <label>马图标大小(px)</label>
        <input v-model="state.form.HORSE_ICON_SIZE" @input="markDisplayInputsDirty" id="nodemc-overlay-horse-icon-size" type="number" min="6" max="40" step="1" />
      </div>
      <div class="n-row">
        <label>马文字大小(px)</label>
        <input v-model="state.form.HORSE_TEXT_SIZE" @input="markDisplayInputsDirty" id="nodemc-overlay-horse-text-size" type="number" min="8" max="32" step="1" />
      </div>
    </div>

    <div class="n-card">
      <div class="n-subtitle">阵营颜色</div>
      <div class="n-row">
        <label>友军颜色(#RRGGBB)</label>
        <div class="n-color-input-wrap">
          <span class="n-color-swatch" :style="{ background: state.form.TEAM_COLOR_FRIENDLY || '#3b82f6' }"></span>
          <input v-model="state.form.TEAM_COLOR_FRIENDLY" @input="markDisplayInputsDirty" id="nodemc-overlay-team-friendly-color" type="text" placeholder="#3b82f6" />
        </div>
      </div>
      <div class="n-row">
        <label>中立颜色(#RRGGBB)</label>
        <div class="n-color-input-wrap">
          <span class="n-color-swatch" :style="{ background: state.form.TEAM_COLOR_NEUTRAL || '#94a3b8' }"></span>
          <input v-model="state.form.TEAM_COLOR_NEUTRAL" @input="markDisplayInputsDirty" id="nodemc-overlay-team-neutral-color" type="text" placeholder="#94a3b8" />
        </div>
      </div>
      <div class="n-row">
        <label>敌军颜色(#RRGGBB)</label>
        <div class="n-color-input-wrap">
          <span class="n-color-swatch" :style="{ background: state.form.TEAM_COLOR_ENEMY || '#ef4444' }"></span>
          <input v-model="state.form.TEAM_COLOR_ENEMY" @input="markDisplayInputsDirty" id="nodemc-overlay-team-enemy-color" type="text" placeholder="#ef4444" />
        </div>
      </div>
    </div>

    <div class="n-card">
      <div class="n-subtitle">上报玩家特殊显示</div>
      <div class="n-row">
        <label>视野圆圈半径 r（方块）</label>
        <input v-model="state.form.REPORTER_VISION_RADIUS" @input="markDisplayInputsDirty" id="nodemc-overlay-reporter-vision-radius" type="number" min="8" max="4096" step="1" />
      </div>
      <div class="n-row">
        <label>上报玩家范围颜色（#RRGGBB，留空跟随阵营色）</label>
        <div class="n-color-input-wrap">
          <span class="n-color-swatch" :style="{ background: state.form.REPORTER_EFFECT_COLOR || state.form.TEAM_COLOR_FRIENDLY || '#3b82f6' }"></span>
          <input v-model="state.form.REPORTER_EFFECT_COLOR" @input="markDisplayInputsDirty" id="nodemc-overlay-reporter-effect-color" type="text" placeholder="#3b82f6" />
        </div>
      </div>
      <div class="n-row">
        <label>视野圆圈透明度（0.02 ~ 0.9）</label>
        <input v-model="state.form.REPORTER_VISION_OPACITY" @input="markDisplayInputsDirty" id="nodemc-overlay-reporter-vision-opacity" type="number" min="0.02" max="0.9" step="0.01" />
      </div>
      <div class="n-row">
        <label>区块半径 l（按玩家所在区块向外）</label>
        <input v-model="state.form.REPORTER_CHUNK_RADIUS" @input="markDisplayInputsDirty" id="nodemc-overlay-reporter-chunk-radius" type="number" min="1" max="64" step="1" />
      </div>
      <div class="n-row">
        <label>区块范围透明度（0.02 ~ 0.9）</label>
        <input v-model="state.form.REPORTER_CHUNK_OPACITY" @input="markDisplayInputsDirty" id="nodemc-overlay-reporter-chunk-opacity" type="number" min="0.02" max="0.9" step="0.01" />
      </div>
      <label class="n-check"><input v-model="state.form.REPORTER_STAR_ICON" @change="triggerAutoApply" id="nodemc-overlay-reporter-star" type="checkbox" />上报玩家图标使用高亮描边标识（替换普通圆点）</label>
      <label class="n-check"><input v-model="state.form.REPORTER_VISION_CIRCLE_ENABLED" @change="triggerAutoApply" id="nodemc-overlay-reporter-vision-circle" type="checkbox" />显示上报玩家视野圆圈</label>
      <label class="n-check"><input v-model="state.form.REPORTER_CHUNK_AREA_ENABLED" @change="triggerAutoApply" id="nodemc-overlay-reporter-chunk-area" type="checkbox" />显示上报玩家区块范围</label>
    </div>

    <div class="n-btns">
      <button id="nodemc-overlay-save-display" type="button" class="n-btn-primary" :disabled="!state.dirty.displayInputs" @click="saveDisplayInputs">保存显示设置</button>
    </div>
    <div v-if="state.dirty.displayInputs" class="n-dirty-hint">显示页输入框已修改，点击“保存显示设置”后生效</div>
  </div>

  <div class="n-page" :class="{ active: state.page === 'connection' }" id="nodemc-overlay-page-connection">
    <div class="n-nav-row">
      <div>
        <div class="n-subtitle" style="margin: 0">连接设置</div>
        <div class="n-section-copy">这组配置会影响连接状态，保存后自动重连</div>
      </div>
      <button id="nodemc-overlay-back-main-from-connection" type="button" class="n-link-btn" @click="setPage('main')">返回概览</button>
    </div>
    <div class="n-card">
      <div class="n-row full-width">
        <label>Admin WS URL</label>
        <input v-model="state.form.ADMIN_WS_URL" @input="markConnectionDirty" id="nodemc-overlay-url" type="text" />
      </div>
      <div class="n-row">
        <label>房间号 Room Code</label>
        <input v-model="state.form.ROOM_CODE" @input="markConnectionDirty" id="nodemc-overlay-room-code" type="text" placeholder="default" />
      </div>
      <div class="n-row">
        <label>重连间隔(ms)</label>
        <input v-model="state.form.RECONNECT_INTERVAL_MS" @input="markConnectionDirty" id="nodemc-overlay-reconnect" type="number" min="200" max="60000" step="100" />
      </div>
      <div class="n-row">
        <label>维度过滤</label>
        <input v-model="state.form.TARGET_DIMENSION" @input="markConnectionDirty" id="nodemc-overlay-dim" type="text" placeholder="minecraft:overworld" />
      </div>
    </div>
    <div class="n-btns">
      <button id="nodemc-overlay-save-connection" type="button" class="n-btn-primary" :disabled="!state.dirty.connection" @click="saveConnectionSettings">应用连接设置</button>
      <button id="nodemc-overlay-refresh-connection" type="button" class="n-btn-ghost" @click="actions.onRefresh">立即重连</button>
    </div>
    <div v-if="state.dirty.connection" class="n-dirty-hint">连接输入项已修改，点击“应用连接设置”后保存并重连</div>
  </div>

  <div class="n-page" :class="{ active: state.page === 'advanced' }" id="nodemc-overlay-page-advanced">
    <div class="n-nav-row">
      <div>
        <div class="n-subtitle" style="margin: 0">高级设置</div>
        <div class="n-section-copy">这部分偏向行为控制和高级显示逻辑</div>
      </div>
      <button id="nodemc-overlay-back-main" type="button" class="n-link-btn" @click="setPage('main')">返回概览</button>
    </div>
    <div class="n-card">
      <label class="n-check"><input v-model="state.form.BLOCK_MAP_LEFT_RIGHT_CLICK" @change="triggerAutoApply" id="nodemc-overlay-block-map-click" type="checkbox" />屏蔽原网页地图左/右键功能（保留拖拽与滚轮缩放）</label>
      <label class="n-check"><input v-model="state.form.ENABLE_TACTICAL_MAP_MARKING" @change="triggerAutoApply" id="nodemc-overlay-enable-tactical-marking" type="checkbox" />启用战术地图标记（右键空白处选择类型后落点，右键已有 waypoint 删除）</label>
      <div class="n-row full-width">
        <label>战术标记默认有效期（秒，右键时可改为 long 长期）</label>
        <input v-model="state.form.TACTICAL_MARK_DEFAULT_TTL_SECONDS" @change="triggerAutoApply" id="nodemc-overlay-tactical-ttl" type="number" min="10" max="86400" step="10" />
      </div>
      <label class="n-check"><input v-model="state.form.BLOCK_MAP_HOVER_POPUP" @change="triggerAutoApply" id="nodemc-overlay-block-map-hover-popup" type="checkbox" />屏蔽原网页地图鼠标悬浮弹窗</label>
      <label class="n-check"><input v-model="state.form.DEBUG" @change="triggerAutoApply" id="nodemc-overlay-debug" type="checkbox" />调试日志</label>
      <label class="n-check"><input v-model="state.sameServerFilterEnabled" @change="onServerFilterChange" id="nodemc-overlay-server-filter" type="checkbox" />同服隔离广播（服务端）</label>
    </div>
  </div>

  <div class="n-page" :class="{ active: state.page === 'help' }" id="nodemc-overlay-page-help">
    <div class="n-nav-row">
      <div>
        <div class="n-subtitle" style="margin: 0">使用帮助</div>
      </div>
      <button id="nodemc-overlay-back-main-from-help" type="button" class="n-link-btn" @click="setPage('main')">返回概览</button>
    </div>
    <div class="n-card">
      <div class="n-help-content full-width">
        <ol class="n-help-list">
          <li>先看概览页状态。如果显示“待连接”或“需要处理”，优先进入“连接设置”。</li>
          <li>在连接设置里填写 <b>Admin WS URL</b>、房间号和维度过滤，保存后会自动重连。</li>
          <li>需要给玩家分类或贴标签时，统一进入“标记”页处理，不在概览页重复操作。</li>
          <li>需要调整地图展示效果时，进入“显示”页统一修改尺寸、颜色和特殊显示。</li>
          <li>想快速看地图目标时，直接打开“地图玩家列表”，列表里点击玩家即可聚焦地图。</li>
        </ol>
        <div class="n-help-tip">
          <ul>
            <li>小贴士：Tab 玩家列表中的名称前缀通常就是标签，可配合“按名字标签自动判定友敌”。</li>
            <li>如果出现连接异常，先点“立即重连”，再检查 URL、房间号和后端是否在线。</li>
          </ul>
        </div>
      </div>
    </div>
  </div>

</template>