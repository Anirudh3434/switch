// DevTools Inspect Right Sidebar & Token Suction Warp Animation
// Replicates Chrome/Edge DevTools (Application > Storage > Cookies) docked right,
// extracts session tokens, and plays a physics suction warp effect pulling tokens
// into the browser's extension action button with browser-accurate coordinates.

(() => {
  if (window.__switchInspectSyncAnimationLoaded) return;
  window.__switchInspectSyncAnimationLoaded = true;

  const ROOT_ID = 'switch-inspect-anim-host';

  // -------------------------------------------------------------
  // 1. Browser & Platform Detection with Exact Coordinate Mapping
  // -------------------------------------------------------------
  function detectBrowserAndPosition() {
    const ua = navigator.userAgent || '';
    const isMac = /Macintosh|Mac OS X/i.test(ua);
    const isWindows = /Windows NT|Windows/i.test(ua);
    const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);

    let browserKey = 'chrome';
    let browserLabel = 'Google Chrome';

    if (/Edg\//i.test(ua)) {
      browserKey = 'edge';
      browserLabel = 'Microsoft Edge';
    } else if ((window.navigator.brave && typeof window.navigator.brave.isBrave === 'function') || /Brave/i.test(ua)) {
      browserKey = 'brave';
      browserLabel = 'Brave Browser';
    } else if (/OPR\/|Opera/i.test(ua)) {
      browserKey = 'opera';
      browserLabel = 'Opera';
    } else if (/Firefox\//i.test(ua)) {
      browserKey = 'firefox';
      browserLabel = 'Mozilla Firefox';
    } else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) {
      browserKey = 'safari';
      browserLabel = 'Safari';
    } else if (/Chrome\//i.test(ua)) {
      browserKey = 'chrome';
      browserLabel = 'Google Chrome';
    }

    const osLabel = isWindows ? 'Windows 10/11' : isMac ? 'macOS' : isLinux ? 'Linux' : 'Desktop OS';

    let offsetRight = 178; // px from right edge of viewport
    let offsetY = -28;     // px above viewport (in browser toolbar)

    if (isMac) {
      // macOS has window controls on top-left, so top-right is just browser menu + extensions
      switch (browserKey) {
        case 'chrome':  offsetRight = 76; break;
        case 'edge':    offsetRight = 92; break;
        case 'brave':   offsetRight = 98; break;
        case 'firefox': offsetRight = 64; break;
        case 'opera':   offsetRight = 82; break;
        case 'safari':  offsetRight = 88; break;
        default:        offsetRight = 76; break;
      }
      offsetY = -24;
    } else if (isWindows) {
      // Windows 10/11: 138px window controls (min, max, close) + browser menus
      switch (browserKey) {
        case 'chrome':  offsetRight = 178; break; // ~138px controls + 38px 3-dots
        case 'edge':    offsetRight = 218; break; // 138px controls + 42px Copilot + 36px 3-dots
        case 'brave':   offsetRight = 236; break; // 138px controls + Brave Shields/Rewards + 38px menu
        case 'firefox': offsetRight = 162; break; // 135px controls + 38px hamburger
        case 'opera':   offsetRight = 186; break; // 138px controls + Easy setup
        default:        offsetRight = 180; break;
      }
      offsetY = -28;
    } else {
      // Linux / other
      offsetRight = 165;
      offsetY = -26;
    }

    const targetX = Math.max(50, window.innerWidth - offsetRight);
    const targetY = offsetY;

    return {
      browserKey,
      browserLabel,
      osLabel,
      offsetRight,
      offsetY,
      targetX,
      targetY,
    };
  }

  // -------------------------------------------------------------
  // 2. Cookie Helpers & Sanitization
  // -------------------------------------------------------------
  function getSampleCookiesForDomain(domain) {
    const d = domain || location.hostname;
    return [
      { name: 'session_id', value: 's%3A7h9K2v8N1mP0qR.wE9xL4zT', domain: '.' + d, path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: 'Session' },
      { name: 'auth_token', value: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...', domain: '.' + d, path: '/', httpOnly: true, secure: true, sameSite: 'Strict', expires: '2027-10-16' },
      { name: 'user_pref', value: 'theme%3Ddark%26lang%3Den-US', domain: d, path: '/', httpOnly: false, secure: false, sameSite: 'Lax', expires: '2027-04-12' },
      { name: 'csrf_nonce', value: '4a8f9c0e2b1d3a5f6e7d8c9b0a1', domain: d, path: '/', httpOnly: false, secure: true, sameSite: 'Strict', expires: 'Session' },
      { name: 'account_ref', value: 'usr_992147_enterprise', domain: '.' + d, path: '/', httpOnly: true, secure: true, sameSite: 'Lax', expires: '2026-12-31' },
      { name: 'device_sig', value: 'sig_ed25519_a4b9c1d8', domain: '.' + d, path: '/', httpOnly: true, secure: true, sameSite: 'None', expires: '2028-01-01' },
    ];
  }

  function formatCookieList(domain, rawCookies) {
    if (Array.isArray(rawCookies) && rawCookies.length > 0) {
      return rawCookies.map((c) => ({
        name: c.name || 'token',
        value: c.value || '',
        domain: c.domain || domain || location.hostname,
        path: c.path || '/',
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite || 'Lax',
        expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString().split('T')[0] : (c.session ? 'Session' : 'Session'),
        size: (c.name ? c.name.length : 0) + (c.value ? c.value.length : 0),
      }));
    }

    // Try reading document.cookie
    try {
      const parts = document.cookie ? document.cookie.split(';') : [];
      if (parts.length > 0 && parts[0].trim()) {
        return parts.map((p) => {
          const idx = p.indexOf('=');
          const k = idx > -1 ? p.slice(0, idx).trim() : p.trim();
          const v = idx > -1 ? p.slice(idx + 1).trim() : '';
          return {
            name: k,
            value: v,
            domain: domain || location.hostname,
            path: '/',
            httpOnly: false,
            secure: location.protocol === 'https:',
            sameSite: 'Lax',
            expires: 'Session',
            size: k.length + v.length,
          };
        });
      }
    } catch {}

    return getSampleCookiesForDomain(domain);
  }

  function isAuthCookie(name, val) {
    const n = String(name || '').toLowerCase();
    const v = String(val || '').toLowerCase();
    return (
      n.includes('auth') ||
      n.includes('session') ||
      n.includes('token') ||
      n.includes('jwt') ||
      n.includes('sid') ||
      n.includes('user') ||
      n.includes('key') ||
      v.startsWith('eyj') ||
      v.startsWith('s%3a')
    );
  }

  // -------------------------------------------------------------
  // 3. DevTools CSS Stylesheet (Authentic Dark Theme)
  // -------------------------------------------------------------
  const DEVTOOLS_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      color: #e8eaed;
      user-select: none;
      box-sizing: border-box;
    }

    *, *::before, *::after {
      box-sizing: inherit;
    }

    /* Screen Backdrop Shade */
    .dt-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(2px);
      opacity: 0;
      transition: opacity 0.3s ease;
      pointer-events: auto;
    }
    .dt-backdrop.active {
      opacity: 1;
    }

    /* Top Extension Intake Target HUD */
    .ext-intake-target {
      position: absolute;
      top: 0;
      transform: translateX(-50%);
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      z-index: 2147483647;
      opacity: 0;
      transition: opacity 0.35s ease, transform 0.35s ease;
    }
    .ext-intake-target.active {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .intake-beacon {
      position: relative;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .intake-ring {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      border: 2px solid #38bdf8;
      box-shadow: 0 0 16px #38bdf8, inset 0 0 12px #38bdf8;
      animation: intakePulse 1.4s cubic-bezier(0.2, 0.8, 0.2, 1) infinite;
    }
    .intake-ring-outer {
      position: absolute;
      inset: -8px;
      border-radius: 50%;
      border: 1px dashed rgba(56, 189, 248, 0.5);
      animation: intakeSpin 6s linear infinite;
    }
    .intake-core {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: radial-gradient(circle, #ffffff 0%, #38bdf8 60%, #818cf8 100%);
      box-shadow: 0 0 20px #38bdf8, 0 0 32px #818cf8;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #0f172a;
      font-weight: 800;
      font-size: 11px;
    }
    .intake-label-badge {
      margin-top: 6px;
      background: rgba(15, 23, 42, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.6);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.6), 0 0 14px rgba(56, 189, 248, 0.3);
      border-radius: 20px;
      padding: 4px 12px;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      color: #f8fafc;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .intake-label-badge .badge-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
      animation: dotPulse 1.2s ease infinite;
    }

    /* DevTools Inspect Right Sidebar */
    .dt-sidebar {
      position: absolute;
      top: 0;
      right: 0;
      width: 540px;
      max-width: 92vw;
      height: 100vh;
      background: #202124;
      border-left: 1px solid #3c4043;
      box-shadow: -10px 0 35px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: auto;
      z-index: 2147483647;
      overflow: hidden;
    }
    .dt-sidebar.open {
      transform: translateX(0);
    }

    /* DevTools Top Header Bar */
    .dt-header {
      height: 38px;
      background: #292a2d;
      border-bottom: 1px solid #3c4043;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 6px 0 8px;
      flex-shrink: 0;
    }
    .dt-header-left {
      display: flex;
      align-items: center;
      height: 100%;
      gap: 2px;
      overflow-x: auto;
    }
    .dt-icon-btn {
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      color: #9aa0a6;
      cursor: pointer;
      border: none;
      background: transparent;
      padding: 0;
      transition: background 0.15s, color 0.15s;
    }
    .dt-icon-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #e8eaed;
    }
    .dt-header-divider {
      width: 1px;
      height: 16px;
      background: #3c4043;
      margin: 0 4px;
    }
    .dt-tab {
      padding: 0 10px;
      height: 100%;
      display: flex;
      align-items: center;
      font-size: 11.5px;
      color: #9aa0a6;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      white-space: nowrap;
      transition: color 0.15s, border-color 0.15s;
    }
    .dt-tab:hover {
      color: #e8eaed;
    }
    .dt-tab.active {
      color: #8ab4f8;
      border-bottom-color: #8ab4f8;
      font-weight: 500;
    }
    .dt-header-right {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .dt-close-btn {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #9aa0a6;
      cursor: pointer;
      border-radius: 4px;
      transition: background 0.15s, color 0.15s;
    }
    .dt-close-btn:hover {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }

    /* Breadcrumbs Bar */
    .dt-breadcrumbs {
      height: 28px;
      background: #24272b;
      border-bottom: 1px solid #3c4043;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      font-size: 11px;
      color: #9aa0a6;
      flex-shrink: 0;
    }
    .dt-crumbs-path {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dt-crumb-highlight {
      color: #8ab4f8;
      font-weight: 600;
    }
    .dt-live-pill {
      display: flex;
      align-items: center;
      gap: 5px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: #10b981;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
    }

    /* Filter & Toolbar */
    .dt-toolbar {
      height: 32px;
      background: #202124;
      border-bottom: 1px solid #3c4043;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      gap: 8px;
      flex-shrink: 0;
    }
    .dt-filter-box {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #292a2d;
      border: 1px solid #3c4043;
      border-radius: 4px;
      padding: 2px 8px;
      height: 22px;
      width: 170px;
    }
    .dt-filter-box input {
      background: transparent;
      border: none;
      outline: none;
      color: #e8eaed;
      font-size: 11px;
      width: 100%;
      font-family: inherit;
    }
    .dt-toolbar-stats {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: #9aa0a6;
    }
    .dt-sec-chip {
      background: rgba(138, 180, 248, 0.15);
      color: #8ab4f8;
      border: 1px solid rgba(138, 180, 248, 0.3);
      padding: 1px 7px;
      border-radius: 3px;
      font-size: 10px;
      font-family: "JetBrains Mono", Consolas, monospace;
    }

    /* Cookies Table */
    .dt-table-container {
      flex: 1;
      overflow-y: auto;
      overflow-x: auto;
      position: relative;
      background: #202124;
    }
    .dt-table {
      width: 100%;
      border-collapse: collapse;
      font-family: "JetBrains Mono", Consolas, "SF Mono", monospace;
      font-size: 11px;
      text-align: left;
    }
    .dt-table th {
      position: sticky;
      top: 0;
      background: #292a2d;
      color: #9aa0a6;
      font-weight: 500;
      font-size: 11px;
      padding: 5px 8px;
      border-bottom: 1px solid #3c4043;
      border-right: 1px solid #34373b;
      white-space: nowrap;
      z-index: 10;
    }
    .dt-table td {
      padding: 5px 8px;
      border-bottom: 1px solid #282a2d;
      border-right: 1px solid #282a2d;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: #bdc1c6;
      position: relative;
    }
    .dt-table tr:nth-child(even) td {
      background: #232529;
    }
    .dt-table tr:hover td {
      background: #2a2e33;
    }
    .dt-table tr.suction-active td {
      background: rgba(56, 189, 248, 0.16) !important;
      color: #38bdf8;
      transition: background 0.3s;
    }
    .cookie-name {
      color: #8ab4f8;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cookie-badge-auth {
      background: rgba(245, 158, 11, 0.2);
      border: 1px solid rgba(245, 158, 11, 0.5);
      color: #f59e0b;
      font-size: 9px;
      padding: 0 4px;
      border-radius: 2px;
      font-weight: 700;
    }
    .cookie-val {
      color: #9aa0a6;
      max-width: 130px;
    }
    .check-yes {
      color: #81c995;
      font-weight: 700;
    }

    /* DevTools Bottom Progress & Sync Console */
    .dt-console-panel {
      height: 145px;
      background: #18191c;
      border-top: 1px solid #3c4043;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }
    .dt-console-header {
      height: 24px;
      background: #202124;
      border-bottom: 1px solid #3c4043;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px;
      font-size: 10.5px;
      color: #9aa0a6;
      font-weight: 600;
    }
    .dt-console-logs {
      flex: 1;
      padding: 8px 10px;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 11px;
      line-height: 1.5;
      overflow-y: auto;
      color: #bdc1c6;
    }
    .log-line {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
    }
    .log-line.info { color: #8ab4f8; }
    .log-line.encrypt { color: #c58af9; }
    .log-line.success { color: #81c995; font-weight: 600; }
    .log-tag {
      background: rgba(255, 255, 255, 0.08);
      padding: 0 4px;
      border-radius: 2px;
      font-size: 9.5px;
      color: #9aa0a6;
    }
    .dt-progress-bar-wrap {
      height: 3px;
      background: #292a2d;
      position: relative;
    }
    .dt-progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #38bdf8 0%, #818cf8 50%, #10b981 100%);
      box-shadow: 0 0 8px #38bdf8;
      transition: width 0.2s ease;
    }

    /* Floating Suction Particle Canvas / Tokens */
    .token-capsule {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 20px;
      background: rgba(15, 23, 42, 0.94);
      border: 1px solid #38bdf8;
      box-shadow: 0 0 16px rgba(56, 189, 248, 0.6), 0 8px 24px rgba(0, 0, 0, 0.8);
      color: #ffffff;
      font-family: "JetBrains Mono", Consolas, monospace;
      font-size: 11px;
      font-weight: 600;
      white-space: nowrap;
      will-change: transform, opacity;
    }
    .token-capsule .token-icon {
      font-size: 13px;
    }
    .token-capsule .token-name {
      color: #38bdf8;
      font-weight: 700;
    }
    .token-capsule .token-hash {
      color: #94a3b8;
      font-size: 9.5px;
    }

    /* Particle sparks canvas */
    .suction-canvas {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 2147483647;
    }

    /* Shockwave ring at intake position */
    .shockwave-ring {
      position: fixed;
      pointer-events: none;
      border-radius: 50%;
      border: 2px solid #38bdf8;
      box-shadow: 0 0 20px #38bdf8;
      z-index: 2147483647;
      animation: shockwaveExpand 0.6s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
    }

    @keyframes intakePulse {
      0% { transform: scale(0.85); opacity: 0.9; }
      50% { transform: scale(1.15); opacity: 0.4; }
      100% { transform: scale(0.85); opacity: 0.9; }
    }
    @keyframes intakeSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes dotPulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    @keyframes shockwaveExpand {
      0% { width: 10px; height: 10px; opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { width: 140px; height: 140px; opacity: 0; transform: translate(-50%, -50%) scale(1.8); }
    }
  `;

  // -------------------------------------------------------------
  // 4. Main Animation Orchestrator
  // -------------------------------------------------------------
  function runInspectSyncAnimation(options = {}) {
    // Prevent concurrent runs
    if (document.getElementById(ROOT_ID)) {
      document.getElementById(ROOT_ID).remove();
    }

    const hostDomain = options.domain || location.hostname || 'site.com';
    const rawCookies = formatCookieList(hostDomain, options.cookies);
    const { browserLabel, osLabel, targetX, targetY, offsetRight } = detectBrowserAndPosition();

    // Create Host Element & Shadow Root
    const hostEl = document.createElement('div');
    hostEl.id = ROOT_ID;
    document.documentElement.appendChild(hostEl);

    const shadow = hostEl.attachShadow({ mode: 'open' });

    // Inject Stylesheet
    const styleEl = document.createElement('style');
    styleEl.textContent = DEVTOOLS_CSS;
    shadow.appendChild(styleEl);

    // Canvas for suction particle trails & warp field
    const canvas = document.createElement('canvas');
    canvas.className = 'suction-canvas';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    shadow.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'dt-backdrop';
    shadow.appendChild(backdrop);

    // Extension Intake Beacon HUD
    const intakeTarget = document.createElement('div');
    intakeTarget.className = 'ext-intake-target';
    intakeTarget.style.left = `${targetX}px`;
    intakeTarget.innerHTML = `
      <div class="intake-beacon">
        <div class="intake-ring-outer"></div>
        <div class="intake-ring"></div>
        <div class="intake-core">⚡</div>
      </div>
      <div class="intake-label-badge">
        <span class="badge-dot"></span>
        <span>SWITCH EXTENSION INTAKE</span>
        <span style="opacity:0.6;font-size:10px;">(${browserLabel})</span>
      </div>
    `;
    shadow.appendChild(intakeTarget);

    // DevTools Sidebar
    const sidebar = document.createElement('div');
    sidebar.className = 'dt-sidebar';
    sidebar.innerHTML = `
      <!-- Top DevTools Header Bar -->
      <div class="dt-header">
        <div class="dt-header-left">
          <button class="dt-icon-btn" title="Inspect element">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v20M2 12h20M7 7l10 10M17 7L7 17"/>
            </svg>
          </button>
          <button class="dt-icon-btn" title="Toggle device toolbar">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
              <line x1="12" y1="18" x2="12" y2="18"/>
            </svg>
          </button>
          <div class="dt-header-divider"></div>
          <div class="dt-tab">Elements</div>
          <div class="dt-tab">Console</div>
          <div class="dt-tab">Sources</div>
          <div class="dt-tab">Network</div>
          <div class="dt-tab active">Application</div>
        </div>
        <div class="dt-header-right">
          <button class="dt-icon-btn" title="DevTools Settings">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
          <div class="dt-close-btn" id="dt-close-trigger" title="Close DevTools">✕</div>
        </div>
      </div>

      <!-- Breadcrumbs Bar -->
      <div class="dt-breadcrumbs">
        <div class="dt-crumbs-path">
          <span>Application</span>
          <span>›</span>
          <span>Storage</span>
          <span>›</span>
          <span>Cookies</span>
          <span>›</span>
          <span class="dt-crumb-highlight">https://${hostDomain}</span>
        </div>
        <div class="dt-live-pill">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;"></span>
          <span>DB SYNC ACTIVE</span>
        </div>
      </div>

      <!-- Filter & Action Toolbar -->
      <div class="dt-toolbar">
        <div class="dt-filter-box">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" stroke-width="2">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="text" placeholder="Filter" value="" readonly />
        </div>
        <div class="dt-toolbar-stats">
          <span class="dt-sec-chip">AES-256-GCM</span>
          <span id="dt-cookie-count-stat">${rawCookies.length} cookies</span>
        </div>
      </div>

      <!-- Cookies Table -->
      <div class="dt-table-container">
        <table class="dt-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Domain</th>
              <th>Path</th>
              <th>Expires / Max-Age</th>
              <th>Size</th>
              <th>HttpOnly</th>
              <th>Secure</th>
              <th>SameSite</th>
            </tr>
          </thead>
          <tbody id="dt-table-body">
            ${rawCookies
              .map((c, i) => {
                const isAuth = isAuthCookie(c.name, c.value);
                const valPreview = c.value ? c.value.slice(0, 16) + (c.value.length > 16 ? '…' : '') : '';
                return `
                  <tr data-cookie-index="${i}">
                    <td class="cookie-name">
                      <span>${c.name}</span>
                      ${isAuth ? '<span class="cookie-badge-auth">AUTH</span>' : ''}
                    </td>
                    <td class="cookie-val" title="${c.value}">${valPreview}</td>
                    <td>${c.domain}</td>
                    <td>${c.path}</td>
                    <td>${c.expires}</td>
                    <td>${c.size} B</td>
                    <td class="${c.httpOnly ? 'check-yes' : ''}">${c.httpOnly ? '✓' : ''}</td>
                    <td class="${c.secure ? 'check-yes' : ''}">${c.secure ? '✓' : ''}</td>
                    <td>${c.sameSite}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>

      <!-- Bottom DevTools Console & Streaming Status -->
      <div class="dt-console-panel">
        <div class="dt-console-header">
          <span>CONSOLE · ENCRYPTED SYNC STREAM</span>
          <span id="dt-progress-counter" style="color:#38bdf8;">0 / ${rawCookies.length} Synced</span>
        </div>
        <div class="dt-progress-bar-wrap">
          <div class="dt-progress-bar" id="dt-progress-bar"></div>
        </div>
        <div class="dt-console-logs" id="dt-console-logs">
          <div class="log-line info">
            <span class="log-tag">INIT</span>
            <span>Inspecting storage for ${hostDomain} on ${browserLabel} (${osLabel})...</span>
          </div>
        </div>
      </div>
    `;
    shadow.appendChild(sidebar);

    // Close Button Handling
    function dismiss() {
      sidebar.classList.remove('open');
      backdrop.classList.remove('active');
      intakeTarget.classList.remove('active');
      setTimeout(() => {
        if (hostEl.parentNode) hostEl.parentNode.removeChild(hostEl);
      }, 400);
    }

    const closeBtn = sidebar.querySelector('#dt-close-trigger');
    if (closeBtn) closeBtn.onclick = dismiss;
    backdrop.onclick = dismiss;
    window.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        dismiss();
        window.removeEventListener('keydown', escHandler);
      }
    });

    // -----------------------------------------------------------
    // Step 1: Open Sidebar & Activate Intake Beacon
    // -----------------------------------------------------------
    requestAnimationFrame(() => {
      sidebar.classList.add('open');
      backdrop.classList.add('active');
      intakeTarget.classList.add('active');
    });

    const consoleLogs = sidebar.querySelector('#dt-console-logs');
    const progressBar = sidebar.querySelector('#dt-progress-bar');
    const progressCounter = sidebar.querySelector('#dt-progress-counter');
    const tableBody = sidebar.querySelector('#dt-table-body');

    function appendLog(type, tag, text) {
      if (!consoleLogs) return;
      const line = document.createElement('div');
      line.className = `log-line ${type}`;
      line.innerHTML = `<span class="log-tag">${tag}</span> <span>${text}</span>`;
      consoleLogs.appendChild(line);
      consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }

    // -----------------------------------------------------------
    // Step 2: Particle Field System (Canvas-driven)
    // -----------------------------------------------------------
    const particles = [];

    function spawnShockwave(x, y) {
      const ring = document.createElement('div');
      ring.className = 'shockwave-ring';
      ring.style.left = `${x}px`;
      ring.style.top = `${Math.max(0, y)}px`;
      shadow.appendChild(ring);
      setTimeout(() => ring.remove(), 600);
    }

    function spawnParticleStream(x, y, targetX, targetY) {
      for (let i = 0; i < 18; i++) {
        particles.push({
          x: x + (Math.random() - 0.5) * 30,
          y: y + (Math.random() - 0.5) * 20,
          startX: x,
          startY: y,
          targetX,
          targetY,
          progress: 0,
          speed: 0.015 + Math.random() * 0.025,
          size: 1.8 + Math.random() * 2.8,
          color: Math.random() > 0.4 ? '#38bdf8' : '#818cf8',
          curvature: (Math.random() - 0.5) * 220,
        });
      }
    }

    let isAnimatingCanvas = true;
    function renderCanvas() {
      if (!isAnimatingCanvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.progress += p.speed;

        // Bezier Arc from (p.startX, p.startY) to (p.targetX, p.targetY)
        const cpX = (p.startX + p.targetX) / 2 + p.curvature;
        const cpY = Math.min(p.startY, p.targetY) - 80;

        const t = p.progress;
        const u = 1 - t;
        const tt = t * t;
        const uu = u * u;

        p.x = uu * p.startX + 2 * u * t * cpX + tt * p.targetX;
        p.y = uu * p.startY + 2 * u * t * cpY + tt * p.targetY;

        // Suction stretch as it nears top
        const alpha = Math.max(0, 1 - t * 0.7);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 8;
        ctx.globalAlpha = alpha;
        ctx.fill();

        if (p.progress >= 1) {
          particles.splice(i, 1);
        }
      }
      ctx.globalAlpha = 1;

      requestAnimationFrame(renderCanvas);
    }
    requestAnimationFrame(renderCanvas);

    // -----------------------------------------------------------
    // Step 3: Suction Warp Sequence for Each Cookie Row
    // -----------------------------------------------------------
    setTimeout(() => {
      appendLog('encrypt', 'ENCRYPT', `Derived AES-GCM-256 vault key. Streaming ${rawCookies.length} tokens to cloud DB...`);

      const rows = tableBody ? tableBody.querySelectorAll('tr') : [];
      let syncedCount = 0;

      rows.forEach((row, idx) => {
        const cookie = rawCookies[idx];
        if (!cookie) return;

        // Stagger each token suction
        setTimeout(() => {
          row.classList.add('suction-active');

          const rect = row.getBoundingClientRect();
          const startX = rect.left + 50;
          const startY = rect.top + rect.height / 2;

          // Create 3D Token Capsule
          const capsule = document.createElement('div');
          capsule.className = 'token-capsule';
          capsule.innerHTML = `
            <span class="token-icon">${isAuthCookie(cookie.name, cookie.value) ? '🔑' : '🍪'}</span>
            <span class="token-name">${cookie.name}</span>
            <span class="token-hash">${cookie.value.slice(0, 8)}…</span>
          `;
          capsule.style.left = `${startX}px`;
          capsule.style.top = `${startY}px`;
          shadow.appendChild(capsule);

          // Spawn ambient particles
          spawnParticleStream(startX, startY, targetX, targetY);

          // Animate Capsule via Physics Suction Curve (Bezier Warp)
          let t = 0;
          const duration = 850; // ms
          const startTime = performance.now();
          const cpX = (startX + targetX) / 2 - 120;
          const cpY = Math.min(startY, targetY) - 140;

          function animateCapsule(now) {
            const elapsed = now - startTime;
            t = Math.min(1, elapsed / duration);

            // Ease in acceleration (singularity vacuum suction)
            const easeT = Math.pow(t, 2.2);
            const u = 1 - easeT;

            const currX = u * u * startX + 2 * u * easeT * cpX + easeT * easeT * targetX;
            const currY = u * u * startY + 2 * u * easeT * cpY + easeT * easeT * targetY;

            // Spaghettification (longitudinal stretch along velocity)
            const stretch = 1 + easeT * 1.8;
            const scaleWarp = Math.max(0.15, 1 - easeT * 0.7);
            const angle = Math.atan2(targetY - currY, targetX - currX) * (180 / Math.PI);

            capsule.style.transform = `translate(${currX - startX}px, ${currY - startY}px) rotate(${angle * 0.4}deg) scale(${scaleWarp}, ${scaleWarp * stretch})`;
            capsule.style.opacity = `${Math.max(0, 1 - easeT * 0.9)}`;

            if (t < 1) {
              requestAnimationFrame(animateCapsule);
            } else {
              // Suction Impact at Extension Icon
              capsule.remove();
              spawnShockwave(targetX, Math.max(0, targetY));

              syncedCount++;
              if (progressCounter) {
                progressCounter.textContent = `${syncedCount} / ${rawCookies.length} Synced`;
              }
              if (progressBar) {
                progressBar.style.width = `${(syncedCount / rawCookies.length) * 100}%`;
              }

              appendLog('info', 'SYNC', `Token "${cookie.name}" encrypted & sucked into Extension Vault (${syncedCount}/${rawCookies.length})`);

              // Final completion check
              if (syncedCount >= rawCookies.length) {
                setTimeout(() => {
                  appendLog('success', 'VAULT', `✓ All ${rawCookies.length} tokens safely stored into encrypted database!`);
                  if (progressCounter) {
                    progressCounter.innerHTML = `<span style="color:#10b981;">✓ 100% Synced & Secured</span>`;
                  }
                  // Keep open for 2.4s so user admires the inspect UI and stats, then gracefully slide away
                  setTimeout(dismiss, 2800);
                }, 300);
              }
            }
          }

          requestAnimationFrame(animateCapsule);
        }, idx * 280 + 350);
      });
    }, 450);
  }

  // -------------------------------------------------------------
  // 5. Message Listener from Background & Popup
  // -------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PLAY_SYNC_INSPECT_ANIMATION') {
      runInspectSyncAnimation({
        domain: msg.domain,
        cookies: msg.cookies,
      });
      sendResponse({ ok: true });
      return true;
    }
  });

  // Expose on window for direct calls if needed
  window.__playSwitchInspectSyncAnimation = runInspectSyncAnimation;
})();
