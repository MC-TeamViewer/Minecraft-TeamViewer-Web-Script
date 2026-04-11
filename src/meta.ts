export const USERSCRIPT_META = {
  name: 'TeamViewRelay 地图投影-squaremap版',
  namespace: 'team-view-relay',
  version: '0.4.11',
  description: '将 TeamViewRelay 的远程玩家与战局区块信息投影到 squaremap 地图',
  author: 'Prof. Chen',
  license: 'MIT',
  homepageURL: 'https://github.com/MC-TeamViewer/Minecraft-TeamViewer-Web-Script',
  homepage: 'https://github.com/MC-TeamViewer/Minecraft-TeamViewer-Web-Script',
  match: [
    'https://map.nodemc.cc/*',
    'http://map.nodemc.cc/*',
    'https://map.fltown.cn/*',
    'http://map.fltown.cn/*',
    'https://map.simmc.cn/*',
    'http://map.simmc.cn/*',
  ] as const,
  'run-at': 'document-start' as const,
  'inject-into': 'page' as const,
  grant: 'none' as const,
};

export const PROTOCOL_META = {
  adminNetworkProtocolVersion: '0.6.2',
  adminMinCompatibleNetworkProtocolVersion: '0.6.1',
};

export const APP_META = {
  storageKey: 'team_view_relay_overlay_settings_v1',
  localProgramPrefix: 'team-view-relay-overlay',
};
