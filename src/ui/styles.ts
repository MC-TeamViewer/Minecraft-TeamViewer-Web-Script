export const UI_STYLE_TEXT = `
  :host {
    --nmc-bg-main: rgba(245, 252, 255, 0.52);
    --nmc-bg-panel: rgba(255, 255, 255, 0.62);
    --nmc-bg-card: rgba(219, 234, 254, 0.36);
    --nmc-border-strong: rgba(59, 130, 246, 0.35);
    --nmc-border-soft: rgba(37, 99, 235, 0.24);
    --nmc-text-main: #0f172a;
    --nmc-text-subtle: #1d4ed8;
    --nmc-text-muted: #334155;
    --nmc-primary: #3b82f6;
    --nmc-primary-hover: #2563eb;
    --nmc-danger: #dc2626;
    --nmc-danger-hover: #b91c1c;
    color-scheme: light;
  }
  #nodemc-overlay-fab {
    position: fixed;
    right: 18px;
    bottom: 96px;
    width: 34px;
    height: 34px;
    border-radius: 999px;
    border: 1px solid rgba(191, 219, 254, 0.6);
    background: radial-gradient(circle at 28% 22%, #93c5fd, #3b82f6 65%, #1d4ed8);
    color: #000;
    font-size: 15px;
    font-weight: 700;
    line-height: 34px;
    text-align: center;
    cursor: pointer;
    z-index: 2147483000;
    box-shadow: 0 12px 30px rgba(29, 78, 216, 0.45), 0 8px 18px rgba(0,0,0,.35);
    user-select: none;
    touch-action: none;
    transition: transform .15s ease, box-shadow .2s ease, filter .2s ease;
  }
  #nodemc-overlay-fab:hover {
    transform: translateY(-1px) scale(1.03);
    filter: brightness(1.08);
  }
  #nodemc-overlay-fab:active {
    transform: translateY(0) scale(0.98);
  }
  #nodemc-overlay-panel {
    position: fixed;
    right: 18px;
    bottom: 160px;
    width: 390px;
    max-width: calc(100vw - 20px);
    max-height: min(82vh, 760px);
    overflow: auto;
    background:
      linear-gradient(150deg, rgba(147, 197, 253, 0.24) 0%, rgba(186, 230, 253, 0.12) 42%),
      var(--nmc-bg-main);
    border: 1px solid var(--nmc-border-strong);
    border-radius: 14px;
    color: var(--nmc-text-main);
    z-index: 2147483000;
    box-shadow: 0 16px 38px rgba(30, 64, 175, 0.22);
    padding: 12px 12px 14px;
    font-size: 12px;
    display: none;
    -webkit-backdrop-filter: blur(16px) saturate(1.18);
    backdrop-filter: blur(16px) saturate(1.18);
    scrollbar-width: thin;
    scrollbar-color: rgba(148, 163, 184, .6) transparent;
    color-scheme: light;
  }
  #nodemc-overlay-panel::-webkit-scrollbar {
    width: 8px;
  }
  #nodemc-overlay-panel::-webkit-scrollbar-track {
    background: transparent;
  }
  #nodemc-overlay-panel::-webkit-scrollbar-thumb {
    background: rgba(148, 163, 184, 0.45);
    border-radius: 999px;
  }
  #nodemc-overlay-panel .n-header {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    padding: 14px;
    border-radius: 14px;
    border: 1px solid rgba(59, 130, 246, 0.24);
    background:
      radial-gradient(circle at top right, rgba(96, 165, 250, 0.34), transparent 34%),
      linear-gradient(145deg, rgba(239, 246, 255, 0.95), rgba(219, 234, 254, 0.72));
    cursor: move;
    user-select: none;
  }
  #nodemc-overlay-panel .n-header-top {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: flex-start;
  }
  #nodemc-overlay-panel .n-primary-tabs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }
  #nodemc-overlay-panel .n-tab-btn {
    border: 1px solid rgba(147, 197, 253, 0.55);
    background: rgba(255, 255, 255, 0.62);
    color: #1e3a8a;
    border-radius: 10px;
    padding: 8px 10px;
    font-weight: 700;
    box-shadow: none;
  }
  #nodemc-overlay-panel .n-tab-btn.active {
    background: linear-gradient(180deg, rgba(59, 130, 246, 0.95), rgba(37, 99, 235, 0.95));
    color: #eff6ff;
    box-shadow: 0 10px 24px rgba(37, 99, 235, 0.24);
  }
  #nodemc-overlay-panel .n-page {
    display: none;
    animation: nodemc-fade-in .16s ease;
  }
  #nodemc-overlay-panel .n-page.active {
    display: block;
  }
  @keyframes nodemc-fade-in {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  #nodemc-overlay-panel .n-card {
    margin-bottom: 10px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--nmc-border-soft);
    background: linear-gradient(180deg, rgba(219, 234, 254, 0.52), rgba(239, 246, 255, 0.42));
  }
  #nodemc-overlay-panel .n-card {
    margin-bottom: 10px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--nmc-border-soft);
    background: linear-gradient(180deg, rgba(219, 234, 254, 0.52), rgba(239, 246, 255, 0.42));
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 10px;
    align-items: start;
  }
  #nodemc-overlay-panel .n-row {
    margin: 0;
  }

  /* allow explicit full-width rows (e.g. Admin WS URL) */
  #nodemc-overlay-panel .n-row.full-width {
    grid-column: 1 / -1;
  }
  /* subtitles should span full width */
  #nodemc-overlay-panel .n-subtitle {
    grid-column: 1 / -1;
    margin-top: 0;
    margin-bottom: 6px;
  }
  /* make nav, button groups and popups occupy full row so inputs pair only with inputs */
  #nodemc-overlay-panel .n-card .n-btns,
  #nodemc-overlay-panel .n-card .n-nav-row,
  #nodemc-overlay-panel .n-card .n-player-list-popup {
    grid-column: 1 / -1;
  }
  #nodemc-overlay-panel .n-card .full-width,
  #nodemc-overlay-panel .full-width {
    grid-column: 1 / -1;
  }
  /* allow checks to be full width when needed via .full-width */
  #nodemc-overlay-panel .n-card .n-check.full-width {
    grid-column: 1 / -1;
  }
  /* ensure .n-row keeps label above control */
  #nodemc-overlay-panel .n-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* compact spacing for small inputs when side-by-side */
  #nodemc-overlay-panel .n-row input[type="number"],
  #nodemc-overlay-panel .n-row input[type="text"],
  #nodemc-overlay-panel .n-row select {
    padding: 6px 8px;
  }
  #nodemc-overlay-panel label {
    display: block;
    margin-bottom: 4px;
    color: #1e3a8a;
    line-height: 1.35;
  }
  #nodemc-overlay-panel input[type="text"],
  #nodemc-overlay-panel input[type="number"],
  #nodemc-overlay-panel select {
    width: 100%;
    box-sizing: border-box;
    border-radius: 9px;
    border: 1px solid rgba(59, 130, 246, 0.42);
    background: var(--nmc-bg-panel);
    color: #000 !important;
    -webkit-text-fill-color: #000;
    padding: 7px 9px;
    outline: none;
    transition: border-color .16s ease, box-shadow .16s ease, background-color .16s ease;
  }
  #nodemc-overlay-panel option {
    color: #000;
    background: #fff;
  }
  #nodemc-overlay-panel input[type="text"]:focus,
  #nodemc-overlay-panel input[type="number"]:focus,
  #nodemc-overlay-panel select:focus {
    border-color: rgba(96, 165, 250, 0.9);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
    background: rgba(255, 255, 255, 1);
  }
  #nodemc-overlay-panel select.is-placeholder {
    color: #64748b !important;
    -webkit-text-fill-color: #64748b;
  }
  #nodemc-overlay-panel input::placeholder {
    color: #64748b;
    -webkit-text-fill-color: #64748b;
  }
  #nodemc-overlay-panel option[value=""] {
    color: #64748b;
  }
  #nodemc-overlay-panel input:-webkit-autofill,
  #nodemc-overlay-panel input:-webkit-autofill:hover,
  #nodemc-overlay-panel input:-webkit-autofill:focus,
  #nodemc-overlay-panel select:-webkit-autofill,
  #nodemc-overlay-panel textarea:-webkit-autofill {
    -webkit-text-fill-color: #000 !important;
    box-shadow: 0 0 0 1000px #fff inset;
    transition: background-color 9999s ease-out 0s;
  }
  #nodemc-overlay-panel .n-check {
    display: flex;
    gap: 7px;
    align-items: flex-start;
    margin-bottom: 7px;
    color: var(--nmc-text-main);
  }
  #nodemc-overlay-panel .n-check input[type="checkbox"] {
    margin-top: 1px;
    accent-color: var(--nmc-primary);
    transform: scale(1.05);
  }
  #nodemc-overlay-panel .n-check.n-check-inline {
    margin-bottom: 0;
  }
  #nodemc-overlay-panel .n-btns {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  #nodemc-overlay-panel .n-eyebrow {
    color: #2563eb;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .08em;
    text-transform: uppercase;
    margin-bottom: 5px;
  }
  #nodemc-overlay-panel .n-hero-title {
    font-size: 20px;
    font-weight: 800;
    color: #0f172a;
    line-height: 1.1;
    margin-bottom: 5px;
  }
  #nodemc-overlay-panel .n-hero-text {
    color: #334155;
    line-height: 1.45;
  }
  #nodemc-overlay-panel .n-status-pill,
  #nodemc-overlay-panel .n-inline-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    font-weight: 700;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  #nodemc-overlay-panel .n-status-pill.is-ok {
    color: #166534;
    background: rgba(187, 247, 208, 0.9);
    border-color: rgba(34, 197, 94, 0.35);
  }
  #nodemc-overlay-panel .n-status-pill.is-error {
    color: #991b1b;
    background: rgba(254, 226, 226, 0.95);
    border-color: rgba(239, 68, 68, 0.35);
  }
  #nodemc-overlay-panel .n-status-pill.is-idle,
  #nodemc-overlay-panel .n-inline-pill.is-warning {
    color: #92400e;
    background: rgba(254, 243, 199, 0.95);
    border-color: rgba(245, 158, 11, 0.35);
  }
  #nodemc-overlay-panel .n-metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 12px;
  }
  #nodemc-overlay-panel .n-metric-card {
    padding: 10px;
    border-radius: 12px;
    border: 1px solid rgba(148, 163, 184, 0.22);
    background: rgba(255, 255, 255, 0.72);
  }
  #nodemc-overlay-panel .n-metric-label {
    color: #64748b;
    font-size: 10px;
    margin-bottom: 4px;
  }
  #nodemc-overlay-panel .n-metric-value {
    color: #0f172a;
    font-size: 17px;
    font-weight: 800;
  }
  #nodemc-overlay-panel .n-overview-card {
    margin-bottom: 12px;
  }
  #nodemc-overlay-panel .n-section-header {
    grid-column: 1 / -1;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 2px;
  }
  #nodemc-overlay-panel .n-section-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
    flex-wrap: wrap;
  }
  #nodemc-overlay-panel .n-section-toggle {
    max-width: 240px;
    padding: 7px 10px;
    border-radius: 10px;
    border: 1px solid rgba(59, 130, 246, 0.18);
    background: rgba(239, 246, 255, 0.72);
    line-height: 1.35;
  }
  #nodemc-overlay-panel .n-section-toggle span {
    color: #1e3a8a;
  }
  #nodemc-overlay-panel .n-quick-grid {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  #nodemc-overlay-panel .n-quick-action {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    min-height: 72px;
    text-align: left;
  }
  #nodemc-overlay-panel .n-quick-action span {
    font-weight: 800;
  }
  #nodemc-overlay-panel .n-quick-action small {
    color: #475569;
    line-height: 1.4;
  }
  #nodemc-overlay-panel .n-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
  }
  #nodemc-overlay-panel .n-chip-btn {
    border: 1px solid rgba(148, 163, 184, 0.28);
    background: rgba(255, 255, 255, 0.82);
    color: #1e293b;
    border-radius: 999px;
    padding: 5px 10px;
    font-weight: 700;
    box-shadow: none;
  }
  #nodemc-overlay-panel .n-chip-btn.active {
    background: rgba(219, 234, 254, 0.96);
    border-color: rgba(59, 130, 246, 0.38);
    color: #1d4ed8;
  }
  #nodemc-overlay-panel .n-segmented {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  #nodemc-overlay-panel .n-segment-btn {
    box-shadow: none;
    background: rgba(255, 255, 255, 0.86);
    color: #1e293b;
    border: 1px solid rgba(148, 163, 184, 0.28);
  }
  #nodemc-overlay-panel .n-segment-btn.active.is-friendly {
    background: rgba(219, 234, 254, 0.95);
    color: #1d4ed8;
    border-color: rgba(59, 130, 246, 0.42);
  }
  #nodemc-overlay-panel .n-segment-btn.active.is-neutral {
    background: rgba(226, 232, 240, 0.95);
    color: #334155;
    border-color: rgba(100, 116, 139, 0.32);
  }
  #nodemc-overlay-panel .n-segment-btn.active.is-enemy {
    background: rgba(254, 226, 226, 0.95);
    color: #b91c1c;
    border-color: rgba(239, 68, 68, 0.4);
  }
  #nodemc-overlay-panel .n-selected-player-card {
    padding: 10px;
    border-radius: 12px;
    background: linear-gradient(135deg, rgba(239, 246, 255, 0.95), rgba(219, 234, 254, 0.82));
    border: 1px solid rgba(59, 130, 246, 0.2);
  }
  #nodemc-overlay-panel .n-selected-player-name {
    color: #0f172a;
    font-weight: 800;
  }
  #nodemc-overlay-panel .n-selected-player-meta {
    margin-top: 4px;
    color: #475569;
    line-height: 1.4;
  }
  #nodemc-overlay-panel .n-color-input-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #nodemc-overlay-panel .n-color-swatch {
    flex: 0 0 18px;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid rgba(15, 23, 42, 0.16);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.4);
  }
  #nodemc-overlay-panel .n-color-input-wrap input {
    flex: 1;
  }
  #nodemc-overlay-panel .n-config-menu {
    margin-top: 8px;
    border: 1px solid var(--nmc-border-soft);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(219, 234, 254, 0.82), rgba(239, 246, 255, 0.74));
    padding: 8px;
  }
  #nodemc-overlay-panel .n-config-menu-items {
    margin-top: 0;
  }
  #nodemc-overlay-panel button {
    border: 1px solid rgba(147,197,253,.48);
    background: linear-gradient(180deg, var(--nmc-primary), var(--nmc-primary-hover));
    color: #000;
    border-radius: 9px;
    padding: 6px 10px;
    font-weight: 600;
    letter-spacing: .2px;
    cursor: pointer;
    transition: transform .12s ease, filter .16s ease, box-shadow .2s ease;
  }
  #nodemc-overlay-panel button:hover {
    transform: translateY(-1px);
    filter: brightness(1.05);
  }
  #nodemc-overlay-panel button:active {
    transform: translateY(0) scale(0.98);
  }
  #nodemc-overlay-panel button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
    filter: none;
    box-shadow: none;
  }
  #nodemc-overlay-panel .n-btn-primary {
    box-shadow: 0 8px 18px rgba(37, 99, 235, 0.28);
  }
  #nodemc-overlay-panel .n-btn-ghost {
    border: 1px solid rgba(59, 130, 246, 0.46);
    background: rgba(239, 246, 255, 0.95);
    color: #1e40af;
    box-shadow: none;
  }
  #nodemc-overlay-panel .n-btn-danger {
    border: 1px solid rgba(254, 202, 202, 0.5);
    background: linear-gradient(180deg, var(--nmc-danger), var(--nmc-danger-hover));
    color: #000;
    box-shadow: 0 8px 18px rgba(185, 28, 28, 0.3);
  }
  #nodemc-overlay-panel .n-link-btn {
    border: 1px solid rgba(59, 130, 246, 0.46);
    background: rgba(239, 246, 255, 0.96);
    color: #1e40af;
    box-shadow: none;
  }
  #nodemc-overlay-panel .n-nav-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    gap: 8px;
    padding: 2px 2px 0;
  }
  #nodemc-overlay-panel .n-player-list-popup {
    margin-top: 10px;
    border: 1px solid var(--nmc-border-soft);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(219, 234, 254, 0.82), rgba(239, 246, 255, 0.74));
    overflow: hidden;
  }
  #nodemc-overlay-panel .n-player-list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--nmc-border-soft);
    background: rgba(191, 219, 254, 0.55);
  }
  #nodemc-overlay-panel .n-player-list-title {
    font-weight: 700;
    color: #1e3a8a;
  }
  #nodemc-overlay-panel .n-player-list-close {
    border: 1px solid rgba(59, 130, 246, 0.46);
    background: rgba(239, 246, 255, 0.96);
    color: #1e40af;
    box-shadow: none;
    padding: 4px 9px;
  }
  #nodemc-overlay-panel .n-player-list-table-wrap {
    max-height: 260px;
    overflow: auto;
  }
  #nodemc-overlay-panel .n-help-content {
    grid-column: 1 / -1;
    padding: 10px;
    color: var(--nmc-text-main);
    line-height: 1.5;
  }
  #nodemc-overlay-panel .n-help-list {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 6px;
  }
  #nodemc-overlay-panel .n-help-list li {
    color: var(--nmc-text-main);
  }
  #nodemc-overlay-panel .n-help-tip {
    margin-top: 10px;
    padding: 8px 9px;
    border-radius: 8px;
    border: 1px dashed rgba(59, 130, 246, 0.45);
    background: rgba(219, 234, 254, 0.65);
    color: #1e40af;
    font-size: 11px;
  }
  #nodemc-overlay-panel .n-player-list-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  #nodemc-overlay-panel .n-player-list-table th,
  #nodemc-overlay-panel .n-player-list-table td {
    padding: 6px 8px;
    border-bottom: 1px solid rgba(59, 130, 246, 0.2);
    text-align: left;
    color: var(--nmc-text-main);
    white-space: nowrap;
  }
  #nodemc-overlay-panel .n-player-list-table th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: rgba(219, 234, 254, 0.95);
    color: #1e3a8a;
    font-weight: 700;
  }
  #nodemc-overlay-panel .n-player-list-row {
    cursor: pointer;
    transition: background-color .15s ease;
  }
  #nodemc-overlay-panel .n-player-list-row:hover {
    background: rgba(191, 219, 254, 0.45);
  }
  #nodemc-overlay-panel .n-player-list-empty {
    text-align: center;
    color: var(--nmc-text-muted);
  }
  #nodemc-overlay-panel .n-team-chip,
  #nodemc-overlay-panel .n-town-chip {
    display: inline-flex;
    align-items: center;
    max-width: 120px;
    padding: 2px 7px;
    border: 1px solid transparent;
    border-radius: 999px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #nodemc-overlay-panel .n-subtitle {
    margin-top: 0;
    margin-bottom: 6px;
    font-weight: 700;
    color: #1e3a8a;
    letter-spacing: .25px;
  }
  #nodemc-overlay-panel .n-dirty-hint {
    margin-top: 6px;
    color: #1e40af;
    font-size: 11px;
    line-height: 1.4;
    background: rgba(219, 234, 254, 0.65);
    border: 1px dashed rgba(59, 130, 246, 0.45);
    border-radius: 8px;
    padding: 6px 8px;
  }
  @media (max-width: 430px) {
    #nodemc-overlay-panel {
      width: min(390px, calc(100vw - 12px));
      max-height: 78vh;
      padding: 10px;
      border-radius: 12px;
    }
    #nodemc-overlay-panel .n-primary-tabs,
    #nodemc-overlay-panel .n-metric-grid,
    #nodemc-overlay-panel .n-quick-grid,
    #nodemc-overlay-panel .n-segmented {
      grid-template-columns: 1fr;
    }
    #nodemc-overlay-panel .n-header-top,
    #nodemc-overlay-panel .n-section-header {
      flex-direction: column;
      align-items: flex-start;
    }
    #nodemc-overlay-panel .n-section-actions {
      width: 100%;
      justify-content: stretch;
    }
    #nodemc-overlay-panel .n-section-toggle {
      max-width: none;
    }
    #nodemc-overlay-panel .n-btns button {
      flex: 1;
      min-width: 42%;
    }
  }
`;

export const OVERLAY_STYLE_TEXT = `
  .nodemc-projection-label {
    background: rgba(0, 0, 0, 0.78);
    color: #000;
    border: 1px solid rgba(255, 255, 255, 0.22);
    border-radius: 6px;
    padding: 3px 7px;
    font-size: 12px;
    line-height: 1.2;
    white-space: nowrap;
  }
  .nodemc-player-label {
    background: rgba(15, 23, 42, 0.55);
    color: #dbeafe;
    border: 1px solid rgba(147, 197, 253, 0.45);
    border-radius: 6px;
    padding: 3px 7px;
    font-size: 12px;
    line-height: 1.2;
    white-space: nowrap;
  }
  .nodemc-player-label .n-team {
    font-weight: 700;
  }
  .nodemc-player-anchor {
    position: relative;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .nodemc-player-anchor .n-icon {
    position: absolute;
    left: 0;
    top: 0;
    width: 10px;
    height: 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.9);
    transform: translate(-50%, -50%);
  }
  .nodemc-player-anchor .n-icon.is-horse {
    width: 14px;
    height: 14px;
    font-size: 10px;
    line-height: 14px;
    text-align: center;
  }
  .nodemc-player-anchor .n-icon.is-reporter-highlight {
    overflow: visible;
  }
  .nodemc-player-anchor .n-icon.is-reporter-highlight::before {
    content: '';
    position: absolute;
    inset: -2px;
    border: 1.5px solid rgba(255, 255, 255, 0.98);
    border-radius: 4px;
    transform: rotate(45deg);
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.82), 0 0 6px var(--reporter-accent-color, rgba(59, 130, 246, 0.7));
  }
  .nodemc-player-anchor .n-icon.is-reporter-highlight::after {
    content: '';
    position: absolute;
    inset: 1px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.68);
  }
  .nodemc-player-anchor .n-label {
    position: absolute;
    top: 0;
    transform: translateY(-50%);
    background: rgba(15, 23, 42, 0.55);
    color: #dbeafe;
    border: 1px solid rgba(147, 197, 253, 0.45);
    border-radius: 6px;
    padding: 3px 7px;
    font-size: 12px;
    line-height: 1.2;
    white-space: nowrap;
  }
  .nodemc-player-anchor .n-label[data-align="with-icon"] {
    left: 10px;
  }
  .nodemc-player-anchor .n-label[data-align="left-anchor"] {
    left: 0;
  }
  .nodemc-player-anchor .n-team {
    font-weight: 700;
  }
  .nodemc-waypoint-anchor {
    position: relative;
    width: 0;
    height: 0;
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
  }
  .nodemc-waypoint-anchor .n-waypoint-icon {
    position: absolute;
    left: 0;
    top: 0;
    transform: translate(-50%, -50%);
    display: inline-block;
    border-radius: 50%;
    text-align: center;
  }
  .nodemc-waypoint-anchor .n-waypoint-label {
    position: absolute;
    top: 0;
    transform: translateY(-50%);
  }
  .nodemc-tactical-anchor {
    position: relative;
    width: 0;
    height: 0;
    pointer-events: auto;
    cursor: pointer;
    user-select: none;
  }
  .nodemc-tactical-anchor .n-tactical-icon {
    position: absolute;
    left: 0;
    top: 0;
    width: 18px;
    height: 18px;
    transform: translate(-50%, -90%);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.95);
    background: rgba(220, 38, 38, 0.9);
    box-shadow: 0 0 0 2px rgba(220, 38, 38, 0.25), 0 0 12px rgba(15, 23, 42, 0.35);
    font-size: 11px;
    line-height: 1;
  }
  .nodemc-tactical-anchor .n-tactical-label {
    position: absolute;
    left: 12px;
    top: -12px;
    transform: translateY(-100%);
    background: rgba(15, 23, 42, 0.78);
    color: #fde68a;
    border: 1px solid rgba(251, 191, 36, 0.55);
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
    line-height: 1.2;
    white-space: nowrap;
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.4);
  }
  .nodemc-tactical-anchor.is-preview .n-tactical-icon {
    width: auto;
    height: auto;
    border: none;
    background: transparent;
    box-shadow: none;
    line-height: 1;
    font-size: 20px;
    transform: translate(-50%, -95%);
    text-shadow: 0 0 2px rgba(255, 255, 255, 0.95), 0 0 8px rgba(15, 23, 42, 0.25);
  }
  .nodemc-tactical-anchor.is-preview .n-tactical-label {
    background: rgba(255, 255, 255, 0.78);
    color: #0f172a;
    border-color: rgba(59, 130, 246, 0.5);
    box-shadow: 0 10px 22px rgba(30, 64, 175, 0.24);
    -webkit-backdrop-filter: blur(10px) saturate(1.1);
    backdrop-filter: blur(10px) saturate(1.1);
  }
  .nodemc-tactical-menu {
    position: fixed;
    z-index: 2147483200;
    width: 268px;
    max-width: calc(100vw - 24px);
    padding: 10px;
    border-radius: 10px;
    border: 1px solid rgba(59, 130, 246, 0.38);
    background:
      linear-gradient(150deg, rgba(147, 197, 253, 0.26) 0%, rgba(186, 230, 253, 0.14) 42%),
      rgba(245, 252, 255, 0.52);
    color: #000;
    box-shadow: 0 14px 30px rgba(30, 64, 175, 0.24);
    -webkit-backdrop-filter: blur(16px) saturate(1.18);
    backdrop-filter: blur(16px) saturate(1.18);
    font-size: 12px;
    line-height: 1.35;
    color-scheme: light;
  }
  .nodemc-tactical-menu .nmc-tactical-title {
    font-weight: 700;
    color: #000;
    margin-bottom: 8px;
    letter-spacing: .2px;
  }
  .nodemc-tactical-menu .nmc-tactical-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }
  .nodemc-tactical-menu .nmc-tactical-row > span {
    color: #000;
    font-size: 11px;
  }
  .nodemc-tactical-menu select,
  .nodemc-tactical-menu input {
    width: 100%;
    box-sizing: border-box;
    border-radius: 7px;
    border: 1px solid rgba(59, 130, 246, 0.42);
    background: rgba(255, 255, 255, 0.64);
    color: #000 !important;
    -webkit-text-fill-color: #000;
    padding: 6px 8px;
    outline: none;
  }
  .nodemc-tactical-menu option {
    color: #000;
    background: #fff;
  }
  .nodemc-tactical-menu select:focus,
  .nodemc-tactical-menu input:focus {
    border-color: rgba(96, 165, 250, 0.92);
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
  }
  .nodemc-tactical-menu .nmc-tactical-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .nodemc-tactical-menu button {
    flex: 1;
    border-radius: 8px;
    border: 1px solid rgba(148, 163, 184, 0.45);
    padding: 6px 8px;
    cursor: pointer;
    font-weight: 600;
    color: #000;
    background: rgba(255, 255, 255, 0.62);
  }
  .nodemc-tactical-menu .nmc-tactical-confirm {
    border-color: rgba(96, 165, 250, 0.7);
    background: linear-gradient(180deg, #2563eb, #1d4ed8);
  }
  .nodemc-tactical-menu .nmc-tactical-cancel {
    border-color: rgba(100, 116, 139, 0.65);
    background: rgba(255, 255, 255, 0.72);
  }
`;
