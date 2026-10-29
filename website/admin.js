// Switch Admin Console — authenticated operator client.
//
// The admin API is NOT public and NOT password-shared. Access requires signing
// in with a normal Switch account whose email is listed in the server's
// ADMIN_EMAILS allowlist. The bearer token is kept in sessionStorage (cleared
// when the tab closes) and attached to every request.
//
// There is no demo/fallback dataset. If the API is unreachable or unauthorized
// the console says so instead of inventing numbers.
document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_SERVER = 'http://localhost:8080';
  const SERVER_KEY = 'switch_admin_server';
  const AT_KEY = 'switch_admin_at';
  const RT_KEY = 'switch_admin_rt';
  const EMAIL_KEY = 'switch_admin_email';

  // SVG Icon Templates
  const ICONS = {
    globe: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    copy: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    search: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
    bug: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/></svg>`,
    rocket: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
    lightbulb: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/></svg>`,
    check: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="svg-inline-icon"><polyline points="20 6 9 17 4 12"/></svg>`,
    undo: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="svg-inline-icon"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`,
    trash: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
    key: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><path d="M21 2l-2 2m-1.5 1.5L12 11l4 4 1.5-1.5M16 7l2 2m-9 3l-6 6v3h3l6-6"/></svg>`,
    browser: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" class="svg-inline-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    zap: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" class="svg-inline-icon"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`
  };

  // State
  let overviewData = null;
  let allSessions = [];
  let allFeedbacks = [];
  let allUsers = [];
  let allDevices = [];
  let activeFeedbackFilter = 'all';
  let activeTab = 'sessions';
  let autoRefreshTimer = null;
  let lastPingMs = null;
  let revealPii = false;

  // DOM Elements
  const htmlRoot = document.documentElement;
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const themeToggleLabel = document.getElementById('themeToggleLabel');
  const autoRefreshSelect = document.getElementById('autoRefreshSelect');
  const refreshPulseDot = document.getElementById('refreshPulseDot');
  const quickPingBtn = document.getElementById('quickPingBtn');
  const quickPingLabel = document.getElementById('quickPingLabel');
  const systemClock = document.getElementById('systemClock');
  const dbStatusLabel = document.getElementById('dbStatusLabel');
  const dbLedBulb = document.getElementById('dbLedBulb');
  const revealPiiToggle = document.getElementById('revealPiiToggle');
  const adminIdentity = document.getElementById('adminIdentity');
  const adminSignOutBtn = document.getElementById('adminSignOutBtn');

  // Login gate
  const authGate = document.getElementById('adminAuthGate');
  const authForm = document.getElementById('adminAuthForm');
  const authEmail = document.getElementById('adminAuthEmail');
  const authPassword = document.getElementById('adminAuthPassword');
  const authServer = document.getElementById('adminAuthServer');
  const authError = document.getElementById('adminAuthError');
  const authSubmit = document.getElementById('adminAuthSubmit');

  // Specs Strip
  const specNodeVersion = document.getElementById('specNodeVersion');
  const specPlatform = document.getElementById('specPlatform');
  const specUptime = document.getElementById('specUptime');
  const specMemory = document.getElementById('specMemory');
  const specHeap = document.getElementById('specHeap');

  // Diagnostics Bar
  const diagMemoryRss = document.getElementById('diagMemoryRss');
  const diagHeapUsed = document.getElementById('diagHeapUsed');
  const diagUptime = document.getElementById('diagUptime');
  const diagDatabase = document.getElementById('diagDatabase');

  // Gauges
  const gaugeUsersCount = document.getElementById('gaugeUsersCount');
  const gaugeUsersRecent = document.getElementById('gaugeUsersRecent');
  const gaugeSessionsCount = document.getElementById('gaugeSessionsCount');
  const gaugeSessionsBytes = document.getElementById('gaugeSessionsBytes');
  const gaugeDevicesCount = document.getElementById('gaugeDevicesCount');
  const gaugeDevicesBreakdown = document.getElementById('gaugeDevicesBreakdown');
  const gaugeFeedbackCount = document.getElementById('gaugeFeedbackCount');
  const gaugeFeedbackBreakdown = document.getElementById('gaugeFeedbackBreakdown');
  const gaugeRamPercent = document.getElementById('gaugeRamPercent');
  const memoryProgressBar = document.getElementById('memoryProgressBar');
  const healthStatusBadge = document.getElementById('healthStatusBadge');
  const gaugeCardSessions = document.getElementById('gaugeCardSessions');

  // Tab Badges
  const tabBadgeSessions = document.getElementById('tabBadgeSessions');
  const tabBadgeFeedback = document.getElementById('tabBadgeFeedback');
  const tabBadgeUsers = document.getElementById('tabBadgeUsers');
  const tabBadgeDevices = document.getElementById('tabBadgeDevices');

  // Feedback Counts
  const countPillBug = document.getElementById('countPillBug');
  const countPillImprovement = document.getElementById('countPillImprovement');
  const countPillSuggestion = document.getElementById('countPillSuggestion');
  const sessionsSummaryPill = document.getElementById('sessionsSummaryPill');

  // Tables
  const sessionsTableBody = document.getElementById('sessionsTableBody');
  const feedbackTableBody = document.getElementById('feedbackTableBody');
  const usersTableBody = document.getElementById('usersTableBody');
  const devicesTableBody = document.getElementById('devicesTableBody');
  const retroTerminalConsole = document.getElementById('retroTerminalConsole');

  // Search Inputs
  const sessionSearchInput = document.getElementById('sessionSearchInput');
  const feedbackSearchInput = document.getElementById('feedbackSearchInput');
  const userSearchInput = document.getElementById('userSearchInput');
  const deviceSearchInput = document.getElementById('deviceSearchInput');

  // Modal
  const inspectModal = document.getElementById('inspectModal');
  const modalCategoryBadge = document.getElementById('modalCategoryBadge');
  const modalTitle = document.getElementById('modalTitle');
  const modalBodyContent = document.getElementById('modalBodyContent');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const modalDoneBtn = document.getElementById('modalDoneBtn');
  const modalCopyJsonBtn = document.getElementById('modalCopyJsonBtn');
  let currentModalPayload = null;

  // Toast Container
  const toastContainer = document.getElementById('adminToastContainer');

  /* --------------------------------------------------------------------------
     0. SESSION / API CLIENT
     -------------------------------------------------------------------------- */

  function normalizeServer(raw) {
    let value = String(raw || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
    return value.replace(/\/v1(\/admin)?$/i, '');
  }

  function serverBase() {
    const stored = localStorage.getItem(SERVER_KEY);
    return normalizeServer(stored) || DEFAULT_SERVER;
  }

  const apiBase = () => `${serverBase()}/v1/admin`;

  function getAccessToken() {
    return sessionStorage.getItem(AT_KEY) || '';
  }

  function clearSession() {
    sessionStorage.removeItem(AT_KEY);
    sessionStorage.removeItem(RT_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
  }

  function showAuthGate(message = '') {
    if (authError) {
      authError.textContent = message;
      authError.style.display = message ? 'block' : 'none';
    }
    if (authGate) authGate.hidden = false;
    if (authForm && !authForm.dataset.bound) {
      authForm.dataset.bound = '1';
    }
  }

  function hideAuthGate() {
    if (authGate) authGate.hidden = true;
    if (authEmail) authEmail.value = '';
    if (authPassword) authPassword.value = '';
    if (authError) authError.style.display = 'none';
  }

  function b64url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Same derivation the extension uses: PBKDF2(password, salt + "auth", N, 32).
   * The plaintext password is never sent; only the derived hash is.
   */
  async function deriveAuthHash(password, salt, iterations) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: enc.encode(`${salt}auth`),
        iterations: Number(iterations) || 600000,
        hash: 'SHA-256',
      },
      key,
      256,
    );
    return b64url(new Uint8Array(bits));
  }

  async function signIn(email, password) {
    const base = serverBase();

    const pre = await fetch(`${base}/v1/auth/prelogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (!pre.ok) {
      const body = await pre.json().catch(() => ({}));
      throw new Error(body.message || body.error || `Prelogin failed (${pre.status})`);
    }
    const { kdfSalt, kdfIterations } = await pre.json();
    if (!kdfSalt) throw new Error('Server did not return a KDF salt.');

    const authHash = await deriveAuthHash(password, kdfSalt, kdfIterations);

    const res = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, authHash }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        res.status === 429
          ? 'Too many attempts. Wait a minute and try again.'
          : 'Invalid email or master password.';
      throw new Error(data.message || msg);
    }

    sessionStorage.setItem(AT_KEY, data.accessToken || '');
    sessionStorage.setItem(RT_KEY, data.refreshToken || '');
    sessionStorage.setItem(EMAIL_KEY, data.user?.email || email);
    return data.user;
  }

  /** Rotate the refresh token. The server allows one race with a 409. */
  async function refreshAccessToken() {
    const rt = sessionStorage.getItem(RT_KEY);
    if (!rt) throw new Error('no_refresh_token');

    const attempt = async () =>
      fetch(`${serverBase()}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });

    let res = await attempt();
    if (res.status === 409) {
      await new Promise((r) => setTimeout(r, 1200));
      res = await attempt();
    }
    if (!res.ok) throw new Error('refresh_failed');

    const data = await res.json();
    sessionStorage.setItem(AT_KEY, data.accessToken || '');
    if (data.refreshToken) sessionStorage.setItem(RT_KEY, data.refreshToken);
    return data.accessToken;
  }

  /**
   * Authenticated fetch. Adds the bearer token, retries once after a refresh,
   * and forces the login gate on auth failure. No request is ever sent
   * unauthenticated.
   */
  async function apiFetch(path, options = {}, _retried = false) {
    const token = getAccessToken();
    if (!token) {
      showAuthGate('Sign in to continue.');
      throw new Error('not_authenticated');
    }

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const res = await fetch(`${apiBase()}${path}`, { ...options, headers });

    if (res.status === 401 && !_retried) {
      try {
        const fresh = await refreshAccessToken();
        if (fresh) return apiFetch(path, options, true);
      } catch {
        clearSession();
        showAuthGate('Your session expired. Sign in again.');
        throw new Error('session_expired');
      }
    }

    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      if (body.error === 'admin_not_configured') {
        showAuthGate(
          'The admin console is disabled: no ADMIN_EMAILS are configured on this server.',
        );
      } else {
        showAuthGate(
          'This account is not authorized for the admin console. Ask the operator to add it to ADMIN_EMAILS.',
        );
      }
      clearSession();
      throw new Error(body.error || 'admin_forbidden');
    }

    return res;
  }

  function revealQuery(sep = '?') {
    return revealPii ? `${sep}reveal=1` : '';
  }

  /* --------------------------------------------------------------------------
     1. THEME CONTROLLER (CYBER DECK DEFAULT & RETRO WORKSTATION)
     -------------------------------------------------------------------------- */
  function initTheme() {
    const saved = localStorage.getItem('switch_admin_theme') || 'cyber';
    setTheme(saved);

    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', () => {
        const next = htmlRoot.getAttribute('data-theme') === 'cyber' ? 'retro' : 'cyber';
        setTheme(next);
        showToast(`Theme changed to ${next === 'cyber' ? 'Cyber Deck' : 'Retro Workstation'}`);
      });
    }
  }

  function setTheme(theme) {
    htmlRoot.setAttribute('data-theme', theme);
    localStorage.setItem('switch_admin_theme', theme);
    if (themeToggleLabel) {
      themeToggleLabel.textContent = theme === 'cyber' ? 'Cyber Deck' : 'Retro 90s';
    }
  }

  /* --------------------------------------------------------------------------
     2. HELPERS & FORMATTERS
     -------------------------------------------------------------------------- */
  function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    if (systemClock) systemClock.textContent = `${h}:${m}:${s}`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return '0m';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m ${secs}s`;
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'N/A';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return String(isoStr);
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    const kb = (bytes / 1024).toFixed(1);
    if (bytes < 1024 * 1024) return `${kb} KB`;
    const mb = (bytes / (1024 * 1024)).toFixed(2);
    return `${mb} MB`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg, iconSvg = ICONS.info) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'admin-toast';
    toast.innerHTML = `<span class="toast-icon-wrap">${iconSvg}</span> <span>${escapeHtml(msg)}</span>`;
    toastContainer.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }

  async function copyToClipboard(text, entityName = 'Item') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${entityName} copied to clipboard!`, ICONS.check);
    } catch {
      showToast('Copy failed, manual copy required', ICONS.info);
    }
  }

  function appendTerminalLog(level, msg) {
    if (!retroTerminalConsole) return;
    const line = document.createElement('div');
    line.className = 'terminal-line';
    const ts = new Date().toLocaleTimeString();
    line.innerHTML = `<span class="t-ts">[${ts}]</span> <span class="t-lvl-${escapeHtml(level)}">[${escapeHtml(level)}]</span> ${escapeHtml(msg)}`;
    retroTerminalConsole.insertBefore(line, retroTerminalConsole.firstChild);
  }

  /* --------------------------------------------------------------------------
     3. OVERVIEW TELEMETRY LOADER
     -------------------------------------------------------------------------- */
  async function loadOverview() {
    try {
      const res = await apiFetch(`/overview${revealQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      overviewData = await res.json();

      applyOverview(overviewData);
      if (dbStatusLabel) dbStatusLabel.textContent = 'DB_CONNECTED';
      if (dbLedBulb) dbLedBulb.className = 'led-bulb led-green';
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] overview failed:', err);
      if (dbStatusLabel) dbStatusLabel.textContent = 'UNREACHABLE';
      if (dbLedBulb) dbLedBulb.className = 'led-bulb led-amber';
      markMetricsUnavailable();
    }
  }

  function markMetricsUnavailable() {
    [
      gaugeUsersCount,
      gaugeSessionsCount,
      gaugeDevicesCount,
      gaugeFeedbackCount,
      gaugeRamPercent,
    ].forEach((el) => {
      if (el) el.textContent = '--';
    });
    if (gaugeUsersRecent) gaugeUsersRecent.textContent = 'no connection';
    if (gaugeSessionsBytes) gaugeSessionsBytes.textContent = 'not connected';
    if (gaugeDevicesBreakdown) gaugeDevicesBreakdown.textContent = 'not connected';
    if (gaugeFeedbackBreakdown) gaugeFeedbackBreakdown.textContent = 'not connected';
  }

  function applyOverview(data) {
    if (!data) return;

    // Specs
    const sys = data.system || {};
    if (specNodeVersion) specNodeVersion.textContent = sys.nodeVersion || '--';
    if (specPlatform) specPlatform.textContent = `${sys.platform || '--'} ${sys.arch || ''}`.trim();
    const uptimeStr = formatUptime(sys.uptimeSeconds);
    if (specUptime) specUptime.textContent = uptimeStr;
    if (diagUptime) diagUptime.textContent = uptimeStr;

    const rssMb = sys.memoryRssMb || 0;
    const heapMb = sys.memoryHeapUsedMb || 0;
    if (specMemory) specMemory.textContent = `${rssMb} MB`;
    if (specHeap) specHeap.textContent = `${heapMb} MB`;
    if (diagMemoryRss) diagMemoryRss.textContent = `${rssMb} MB`;
    if (diagHeapUsed) diagHeapUsed.textContent = `${heapMb} MB`;

    // RAM progress is a share of a 256 MB reference, clearly labelled.
    const memPercent = Math.min(Math.round((rssMb / 256) * 100), 100);
    if (gaugeRamPercent) gaugeRamPercent.textContent = `${rssMb} MB`;
    if (memoryProgressBar) memoryProgressBar.style.width = `${Math.max(memPercent, 2)}%`;
    if (healthStatusBadge) {
      if (rssMb > 200) {
        healthStatusBadge.textContent = 'HIGH_RAM';
        healthStatusBadge.className = 'gauge-sub-pill';
      } else {
        healthStatusBadge.textContent = 'NOMINAL';
        healthStatusBadge.className = 'gauge-sub-pill pulse-badge';
      }
    }

    // Counts
    const counts = data.counts || {};
    if (gaugeUsersCount) gaugeUsersCount.textContent = counts.users ?? '--';
    if (tabBadgeUsers) tabBadgeUsers.textContent = counts.users ?? '0';

    if (gaugeSessionsCount) gaugeSessionsCount.textContent = counts.sessions ?? '--';
    if (tabBadgeSessions) tabBadgeSessions.textContent = counts.sessions ?? '0';

    if (gaugeDevicesCount) gaugeDevicesCount.textContent = counts.devices ?? '--';
    if (tabBadgeDevices) tabBadgeDevices.textContent = counts.devices ?? '0';

    if (gaugeFeedbackCount) gaugeFeedbackCount.textContent = counts.feedbacks ?? '--';
    if (tabBadgeFeedback) tabBadgeFeedback.textContent = counts.feedbacks ?? '0';

    // Feedback Breakdown
    const fbByType = counts.feedbackByType || { bug: 0, improvement: 0, suggestion: 0 };
    if (countPillBug) countPillBug.textContent = fbByType.bug || 0;
    if (countPillImprovement) countPillImprovement.textContent = fbByType.improvement || 0;
    if (countPillSuggestion) countPillSuggestion.textContent = fbByType.suggestion || 0;
    if (gaugeFeedbackBreakdown) {
      gaugeFeedbackBreakdown.textContent = `${fbByType.bug || 0} bugs • ${fbByType.improvement || 0} ideas • ${fbByType.suggestion || 0} asks`;
    }

    const recentUsersList = data.recentUsers || [];
    if (gaugeUsersRecent) {
      gaugeUsersRecent.textContent = `${recentUsersList.length} recent`;
    }

    const recentDevicesList = data.recentDevices || [];
    if (gaugeDevicesBreakdown && recentDevicesList.length > 0) {
      const browsers = new Set();
      recentDevicesList.forEach((d) => {
        if (d.browser) browsers.add(d.browser);
      });
      gaugeDevicesBreakdown.textContent = Array.from(browsers).join(' • ') || 'Active fleet';
    }

    if (
      data.logs &&
      data.logs.length > 0 &&
      retroTerminalConsole &&
      retroTerminalConsole.children.length === 0
    ) {
      data.logs.forEach((l) => appendTerminalLog(l.level, l.msg));
    }
  }

  /* --------------------------------------------------------------------------
     4. SESSIONS VAULT
     -------------------------------------------------------------------------- */
  async function loadSessions() {
    try {
      const res = await apiFetch('/sessions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allSessions = data.items || [];
      renderSessions();
      updateSessionsStorageMetrics();
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] sessions failed:', err);
      if (allSessions.length === 0 && sessionsTableBody) {
        sessionsTableBody.innerHTML = `<tr><td colspan="6" class="table-empty-row">Not connected to the admin API.</td></tr>`;
      }
    }
  }

  function updateSessionsStorageMetrics() {
    const totalBytes = allSessions.reduce((acc, s) => acc + (s.envelopeBytes || 0), 0);
    const formatted = formatBytes(totalBytes);
    if (gaugeSessionsBytes) {
      gaugeSessionsBytes.textContent = `~${formatted} sealed`;
    }
    if (sessionsSummaryPill) {
      sessionsSummaryPill.textContent = `${allSessions.length} active host(s) (${formatted})`;
    }
    if (tabBadgeSessions) {
      tabBadgeSessions.textContent = allSessions.length;
    }
  }

  function renderSessions() {
    if (!sessionsTableBody) return;
    const query = (sessionSearchInput ? sessionSearchInput.value : '').toLowerCase().trim();

    const filtered = allSessions.filter((s) => {
      if (!query) return true;
      const host = (s.host || '').toLowerCase();
      const dev = (s.deviceId || '').toLowerCase();
      const user = (s.userId || '').toLowerCase();
      return host.includes(query) || dev.includes(query) || user.includes(query);
    });

    if (filtered.length === 0) {
      sessionsTableBody.innerHTML = `<tr><td colspan="6" class="table-empty-row">No encrypted sessions match the search query.</td></tr>`;
      return;
    }

    sessionsTableBody.innerHTML = filtered
      .map((s) => {
        const host = s.host || 'unknown-origin';
        const bytes = s.envelopeBytes || 0;
        const formattedBytes = formatBytes(bytes);
        const version = s.version ? `v${s.version}` : 'v1';
        const devId = s.deviceId || 'unspecified';
        const shortDev = devId.length > 14 ? `${devId.slice(0, 10)}…` : devId;
        const updated = formatDate(s.updatedAt);

        return `
        <tr>
          <td>
            <div class="host-pill">
              <span class="host-icon">${ICONS.globe}</span>
              <strong style="color:var(--retro-ink-black);">${escapeHtml(host)}</strong>
            </div>
          </td>
          <td>
            <span class="tag-pill-dim">${formattedBytes}</span>
          </td>
          <td>
            <span class="gauge-sub-pill pulse-badge">${escapeHtml(version)}</span>
          </td>
          <td>
            <button type="button" class="copy-chip-btn" data-copy="${escapeHtml(devId)}" title="Copy Device ID">
              <span>${escapeHtml(shortDev)}</span>
              ${ICONS.copy}
            </button>
          </td>
          <td class="table-mono-text" style="color:var(--retro-ink-dim);">${updated}</td>
          <td>
            <div class="table-actions-cell">
              <button type="button" class="retro-btn retro-btn-sm inspect-session-btn" data-id="${escapeHtml(s._id)}" title="Inspect envelope metadata">
                ${ICONS.search}
                <span>Inspect</span>
              </button>
              <button type="button" class="retro-btn retro-btn-sm copy-host-btn" data-host="${escapeHtml(host)}" title="Copy domain">
                ${ICONS.copy}
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');

    sessionsTableBody.querySelectorAll('.inspect-session-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = allSessions.find((s) => s._id === btn.dataset.id);
        if (item) openModal(`Session: ${item.host}`, 'SESSION ENVELOPE', item);
      });
    });

    sessionsTableBody.querySelectorAll('.copy-host-btn').forEach((btn) => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.host, 'Host domain'));
    });

    sessionsTableBody.querySelectorAll('.copy-chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, 'Device ID'));
    });
  }

  /* --------------------------------------------------------------------------
     5. FEEDBACK INBOX
     -------------------------------------------------------------------------- */
  async function loadFeedbacks() {
    try {
      const res = await apiFetch(`/feedbacks${revealQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allFeedbacks = data.items || [];
      renderFeedbacks();
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] feedbacks failed:', err);
      allFeedbacks = [];
      renderFeedbacks();
    }
  }

  function renderFeedbacks() {
    if (!feedbackTableBody) return;
    const query = (feedbackSearchInput ? feedbackSearchInput.value : '').toLowerCase().trim();

    const filtered = allFeedbacks.filter((item) => {
      if (activeFeedbackFilter !== 'all' && item.type !== activeFeedbackFilter) {
        return false;
      }
      if (query) {
        const desc = (item.description || '').toLowerCase();
        const email = (item.email || '').toLowerCase();
        const type = (item.type || '').toLowerCase();
        return desc.includes(query) || email.includes(query) || type.includes(query);
      }
      return true;
    });

    if (filtered.length === 0) {
      feedbackTableBody.innerHTML = `<tr><td colspan="6" class="table-empty-row">No feedback records match the active filter.</td></tr>`;
      return;
    }

    feedbackTableBody.innerHTML = filtered
      .map((item) => {
        const id = item._id || item.id || 'N/A';
        const status = item.status || 'open';
        const type = item.type || 'bug';
        const typeBadgeClass = `type-badge-${type}`;
        const typeSvgIcon =
          type === 'bug' ? ICONS.bug : type === 'improvement' ? ICONS.rocket : ICONS.lightbulb;
        const statusBadgeClass = `status-${status}`;
        const statusLabel = status.toUpperCase();
        const emailText = item.email
          ? escapeHtml(item.email)
          : '<span style="color:var(--retro-ink-faint);">(anonymous)</span>';

        return `
        <tr data-id="${escapeHtml(id)}">
          <td>
            <span class="type-badge-retro ${typeBadgeClass}">
              <span>${typeSvgIcon}</span>
              <span>${escapeHtml(type.toUpperCase())}</span>
            </span>
          </td>
          <td>
            <div class="table-desc-cell" title="${escapeHtml(item.description)}">
              "${escapeHtml(item.description)}"
            </div>
          </td>
          <td>
            <div>${emailText}</div>
          </td>
          <td class="table-mono-text">${formatDate(item.createdAt || item.timestamp)}</td>
          <td>
            <span class="status-badge-retro ${statusBadgeClass}">${statusLabel}</span>
          </td>
          <td>
            <div class="table-actions-cell">
              <button type="button" class="retro-btn retro-btn-sm inspect-feedback-btn" data-id="${escapeHtml(id)}" title="Inspect feedback">
                ${ICONS.search}
              </button>
              ${
                status !== 'resolved'
                  ? `<button type="button" class="retro-btn retro-btn-sm action-resolve-btn" data-id="${escapeHtml(id)}" title="Mark resolved">${ICONS.check} <span>Resolve</span></button>`
                  : `<button type="button" class="retro-btn retro-btn-sm action-reopen-btn" data-id="${escapeHtml(id)}" title="Reopen">${ICONS.undo} <span>Open</span></button>`
              }
              <button type="button" class="retro-btn retro-btn-sm retro-btn-danger action-delete-btn" data-id="${escapeHtml(id)}" title="Purge record">${ICONS.trash}</button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');

    feedbackTableBody.querySelectorAll('.inspect-feedback-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = allFeedbacks.find(
          (f) => f._id === btn.dataset.id || f.id === btn.dataset.id,
        );
        if (item) openModal(`Feedback: ${item.type}`, 'FEEDBACK ITEM', item);
      });
    });

    feedbackTableBody.querySelectorAll('.action-resolve-btn').forEach((btn) => {
      btn.addEventListener('click', () => updateFeedbackStatus(btn.dataset.id, 'resolved'));
    });
    feedbackTableBody.querySelectorAll('.action-reopen-btn').forEach((btn) => {
      btn.addEventListener('click', () => updateFeedbackStatus(btn.dataset.id, 'open'));
    });
    feedbackTableBody.querySelectorAll('.action-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteFeedback(btn.dataset.id));
    });
  }

  async function updateFeedbackStatus(id, newStatus) {
    try {
      const res = await apiFetch(`/feedbacks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      appendTerminalLog('UPDATE', `Feedback ${id.slice(-6)} set to ${newStatus}`);
      showToast(`Feedback updated to ${newStatus}`, ICONS.check);

      allFeedbacks = allFeedbacks.map((f) => {
        if (f._id === id || f.id === id) return { ...f, status: newStatus };
        return f;
      });
      renderFeedbacks();
      loadOverview();
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] patch failed:', err);
      showToast(`Update failed: ${err.message}`, ICONS.info);
    }
  }

  async function deleteFeedback(id) {
    if (!confirm(`Permanently delete feedback record ${id.slice(-6)}?`)) return;

    try {
      const res = await apiFetch(`/feedbacks/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      appendTerminalLog('DELETE', `Feedback ${id.slice(-6)} purged successfully`);
      showToast('Feedback item purged', ICONS.trash);

      allFeedbacks = allFeedbacks.filter((f) => f._id !== id && f.id !== id);
      renderFeedbacks();
      loadOverview();
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] delete failed:', err);
      showToast(`Delete failed: ${err.message}`, ICONS.info);
    }
  }

  /* --------------------------------------------------------------------------
     6. USERS DIRECTORY
     -------------------------------------------------------------------------- */
  async function loadUsers() {
    try {
      const res = await apiFetch(`/users${revealQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allUsers = data.items || [];
      renderUsers();
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] users failed:', err);
      allUsers = [];
      renderUsers();
    }
  }

  function renderUsers() {
    if (!usersTableBody) return;
    const query = (userSearchInput ? userSearchInput.value : '').toLowerCase().trim();

    const filtered = allUsers.filter((u) => {
      if (!query) return true;
      const email = (u.email || '').toLowerCase();
      const id = (u._id || '').toLowerCase();
      return email.includes(query) || id.includes(query);
    });

    if (filtered.length === 0) {
      usersTableBody.innerHTML = `<tr><td colspan="5" class="table-empty-row">No users match the search query.</td></tr>`;
      return;
    }

    usersTableBody.innerHTML = filtered
      .map((u) => {
        const id = u._id || 'N/A';
        const shortId = id.length > 14 ? `${id.slice(0, 10)}…` : id;
        const keyBadge = u.hasPublicKey
          ? `<span class="status-badge-retro status-resolved">${ICONS.key} PUBLIC KEY ON FILE</span>`
          : `<span class="status-badge-retro status-reviewed">NO PUBLIC KEY</span>`;
        const verified = u.emailVerifiedAt
          ? `<span class="status-badge-retro status-resolved">VERIFIED</span>`
          : `<span class="status-badge-retro status-reviewed">UNVERIFIED</span>`;

        return `
        <tr>
          <td>
            <button type="button" class="copy-chip-btn" data-copy="${escapeHtml(id)}" title="Copy user ID">
              <span>${escapeHtml(shortId)}</span>
              ${ICONS.copy}
            </button>
          </td>
          <td><strong>${escapeHtml(u.email || 'N/A')}</strong></td>
          <td>${keyBadge} ${verified}</td>
          <td class="table-mono-text">${formatDate(u.createdAt)}</td>
          <td>
            <button type="button" class="retro-btn retro-btn-sm inspect-user-btn" data-id="${escapeHtml(id)}" title="Inspect user account">
              ${ICONS.search}
              <span>Inspect</span>
            </button>
          </td>
        </tr>
      `;
      })
      .join('');

    usersTableBody.querySelectorAll('.copy-chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, 'User ID'));
    });

    usersTableBody.querySelectorAll('.inspect-user-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = allUsers.find((u) => u._id === btn.dataset.id);
        if (item) openModal(`User: ${item.email}`, 'USER ACCOUNT', item);
      });
    });
  }

  /* --------------------------------------------------------------------------
     7. CONNECTED DEVICES FLEET
     -------------------------------------------------------------------------- */
  async function loadDevices() {
    try {
      const res = await apiFetch('/devices');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allDevices = data.items || [];
      renderDevices();
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      console.warn('[switch-admin] devices failed:', err);
      allDevices = [];
      renderDevices();
    }
  }

  function renderDevices() {
    if (!devicesTableBody) return;
    const query = (deviceSearchInput ? deviceSearchInput.value : '').toLowerCase().trim();

    const filtered = allDevices.filter((d) => {
      if (!query) return true;
      const name = (d.name || '').toLowerCase();
      const devId = (d.deviceId || '').toLowerCase();
      const sysId = (d.systemId || '').toLowerCase();
      return name.includes(query) || devId.includes(query) || sysId.includes(query);
    });

    if (filtered.length === 0) {
      devicesTableBody.innerHTML = `<tr><td colspan="5" class="table-empty-row">No connected devices found.</td></tr>`;
      return;
    }

    devicesTableBody.innerHTML = filtered
      .map((d) => {
        const devId = d.deviceId || 'N/A';
        const shortDev = devId.length > 14 ? `${devId.slice(0, 10)}…` : devId;
        const sysId = d.systemId
          ? `<span class="table-mono-text">${escapeHtml(d.systemId)}</span>`
          : '<span style="color:var(--retro-ink-faint);">unassigned</span>';

        const rawName = d.name || 'Browser device';
        let badgeClass = 'browser-badge-chrome';
        if (rawName.includes('Edge')) badgeClass = 'browser-badge-edge';
        else if (rawName.includes('Firefox')) badgeClass = 'browser-badge-firefox';
        else if (rawName.includes('Brave')) badgeClass = 'browser-badge-brave';

        return `
        <tr>
          <td>
            <button type="button" class="copy-chip-btn" data-copy="${escapeHtml(devId)}" title="Copy device ID">
              <span>${escapeHtml(shortDev)}</span>
              ${ICONS.copy}
            </button>
          </td>
          <td>
            <span class="browser-badge ${badgeClass}">
              <span>${ICONS.browser}</span>
              <span>${escapeHtml(rawName)}</span>
            </span>
          </td>
          <td>${sysId}</td>
          <td class="table-mono-text">${formatDate(d.lastSeenAt || d.createdAt)}</td>
          <td>
            <button type="button" class="retro-btn retro-btn-sm inspect-device-btn" data-id="${escapeHtml(d.deviceId || '')}" title="Inspect device telemetry">
              ${ICONS.search}
              <span>Inspect</span>
            </button>
          </td>
        </tr>
      `;
      })
      .join('');

    devicesTableBody.querySelectorAll('.copy-chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.copy, 'Device ID'));
    });

    devicesTableBody.querySelectorAll('.inspect-device-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = allDevices.find((d) => d.deviceId === btn.dataset.id);
        if (item) openModal(`Device: ${item.name}`, 'CONNECTED DEVICE', item);
      });
    });
  }

  /* --------------------------------------------------------------------------
     8. TAB SWITCHING CONTROLLER
     -------------------------------------------------------------------------- */
  const tabButtons = document.querySelectorAll('.retro-tab-btn');
  const tabPanes = {
    sessions: document.getElementById('tabPaneSessions'),
    feedback: document.getElementById('tabPaneFeedback'),
    users: document.getElementById('tabPaneUsers'),
    devices: document.getElementById('tabPaneDevices'),
    terminal: document.getElementById('tabPaneTerminal'),
  };

  function switchTab(targetTab) {
    activeTab = targetTab;
    tabButtons.forEach((b) => {
      const isTarget = b.dataset.tab === targetTab;
      b.classList.toggle('active', isTarget);
      b.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });

    Object.keys(tabPanes).forEach((k) => {
      if (tabPanes[k]) {
        tabPanes[k].classList.toggle('hidden', k !== targetTab);
      }
    });

    if (targetTab === 'sessions') loadSessions();
    if (targetTab === 'feedback') loadFeedbacks();
    if (targetTab === 'users') loadUsers();
    if (targetTab === 'devices') loadDevices();
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  if (gaugeCardSessions) {
    gaugeCardSessions.addEventListener('click', () => switchTab('sessions'));
  }

  /* --------------------------------------------------------------------------
     9. SEARCH & FILTER LISTENERS
     -------------------------------------------------------------------------- */
  document.querySelectorAll('.retro-filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.retro-filter-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      activeFeedbackFilter = pill.dataset.filter || 'all';
      renderFeedbacks();
    });
  });

  if (sessionSearchInput) sessionSearchInput.addEventListener('input', renderSessions);
  if (feedbackSearchInput) feedbackSearchInput.addEventListener('input', renderFeedbacks);
  if (userSearchInput) userSearchInput.addEventListener('input', renderUsers);
  if (deviceSearchInput) deviceSearchInput.addEventListener('input', renderDevices);

  if (revealPiiToggle) {
    revealPiiToggle.addEventListener('change', () => {
      revealPii = !!revealPiiToggle.checked;
      if (revealPii) {
        appendTerminalLog(
          'AUDIT',
          'Unmasked PII requested — this action is recorded in the admin audit log.',
        );
      }
      loadOverview();
      loadSessions();
      if (activeTab === 'feedback') loadFeedbacks();
      else if (activeTab === 'users') loadUsers();
      else if (activeTab === 'devices') loadDevices();
    });
  }

  // Refresh buttons
  const refreshSessionsBtn = document.getElementById('refreshSessionsBtn');
  if (refreshSessionsBtn)
    refreshSessionsBtn.addEventListener('click', () => {
      loadSessions();
      showToast('Sessions reloaded', ICONS.check);
    });

  const refreshFeedbackBtn = document.getElementById('refreshFeedbackBtn');
  if (refreshFeedbackBtn)
    refreshFeedbackBtn.addEventListener('click', () => {
      loadFeedbacks();
      loadOverview();
      showToast('Feedback inbox reloaded', ICONS.check);
    });

  const refreshUsersBtn = document.getElementById('refreshUsersBtn');
  if (refreshUsersBtn)
    refreshUsersBtn.addEventListener('click', () => {
      loadUsers();
      showToast('Users directory reloaded', ICONS.check);
    });

  const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
  if (refreshDevicesBtn)
    refreshDevicesBtn.addEventListener('click', () => {
      loadDevices();
      showToast('Device fleet reloaded', ICONS.check);
    });

  /* --------------------------------------------------------------------------
     10. CSV EXPORTERS
     -------------------------------------------------------------------------- */
  const exportSessionsCsvBtn = document.getElementById('exportSessionsCsvBtn');
  if (exportSessionsCsvBtn) {
    exportSessionsCsvBtn.addEventListener('click', () => {
      if (allSessions.length === 0) return showToast('No sessions to export', ICONS.info);
      let csv = 'Host,PayloadBytes,Version,DeviceId,UserId,LastSynced\n';
      allSessions.forEach((s) => {
        csv += `"${s.host || ''}",${s.envelopeBytes || 0},"${s.version || 1}","${s.deviceId || ''}","${s.userId || ''}","${s.updatedAt || ''}"\n`;
      });
      downloadBlob(csv, `switch-sessions-${Date.now()}.csv`, 'text/csv');
      showToast('Sessions exported to CSV', ICONS.check);
    });
  }

  const exportUsersCsvBtn = document.getElementById('exportUsersCsvBtn');
  if (exportUsersCsvBtn) {
    exportUsersCsvBtn.addEventListener('click', () => {
      if (allUsers.length === 0) return showToast('No users to export', ICONS.info);
      let csv = 'UserId,Email,HasPublicKey,EmailVerified,RegisteredDate\n';
      allUsers.forEach((u) => {
        csv += `"${u._id || ''}","${u.email || ''}",${u.hasPublicKey ? 'true' : 'false'},${u.emailVerifiedAt ? 'true' : 'false'},"${u.createdAt || ''}"\n`;
      });
      downloadBlob(csv, `switch-users-${Date.now()}.csv`, 'text/csv');
      showToast('Users exported to CSV', ICONS.check);
    });
  }

  function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* --------------------------------------------------------------------------
     11. DIAGNOSTICS & TERMINAL ACTIONS
     -------------------------------------------------------------------------- */
  async function executePing() {
    appendTerminalLog('HEARTBEAT', 'Pinging Switch admin API (/v1/admin/action/ping)...');
    try {
      const start = performance.now();
      const res = await apiFetch('/action/ping', { method: 'POST' });
      lastPingMs = Math.round(performance.now() - start);
      if (res.ok) {
        appendTerminalLog('STATUS', `Pong verified. Latency: ${lastPingMs}ms`);
        if (quickPingLabel) quickPingLabel.textContent = `PING: ${lastPingMs}ms`;
        showToast(`API latency: ${lastPingMs}ms`, ICONS.zap);
      } else {
        appendTerminalLog('UPDATE', `Ping HTTP error: ${res.status}`);
        if (quickPingLabel) quickPingLabel.textContent = 'PING: ERR';
      }
    } catch (err) {
      if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
      appendTerminalLog('UPDATE', `Ping failed: ${err.message}`);
      if (quickPingLabel) quickPingLabel.textContent = 'PING: ERR';
    }
  }

  const pingServerBtn = document.getElementById('pingServerBtn');
  if (pingServerBtn) pingServerBtn.addEventListener('click', executePing);
  if (quickPingBtn) quickPingBtn.addEventListener('click', executePing);

  // Reset Rate Limits
  const resetRateLimitsBtn = document.getElementById('resetRateLimitsBtn');
  if (resetRateLimitsBtn) {
    resetRateLimitsBtn.addEventListener('click', async () => {
      appendTerminalLog('MAINTENANCE', 'Flushing in-memory rate limiters...');
      try {
        const res = await apiFetch('/action/reset-rate-limits', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          appendTerminalLog('STATUS', data.message || 'Rate limit buckets reset successfully');
          showToast('Rate limit buckets reset', ICONS.check);
        } else {
          appendTerminalLog('UPDATE', `Reset error: HTTP ${res.status}`);
        }
      } catch (err) {
        if (err?.message === 'not_authenticated' || err?.message === 'session_expired') return;
        appendTerminalLog('UPDATE', `Reset error: ${err.message}`);
      }
    });
  }

  // Export JSON Audit
  const exportAuditBtn = document.getElementById('exportAuditBtn');
  if (exportAuditBtn) {
    exportAuditBtn.addEventListener('click', () => {
      const dump = {
        exportedAt: new Date().toISOString(),
        operator: sessionStorage.getItem(EMAIL_KEY) || null,
        piiUnmasked: revealPii,
        overview: overviewData,
        sessionsCount: allSessions.length,
        feedbacks: allFeedbacks,
        usersCount: allUsers.length,
        devicesCount: allDevices.length,
      };
      downloadBlob(JSON.stringify(dump, null, 2), `switch-audit-${Date.now()}.json`, 'application/json');
      appendTerminalLog('INFO', 'Audit snapshot exported to client JSON file');
      showToast('Audit snapshot exported', ICONS.check);
    });
  }

  // Clear Terminal Output
  const clearLogBtn = document.getElementById('clearLogBtn');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      if (retroTerminalConsole) retroTerminalConsole.innerHTML = '';
      appendTerminalLog('STATUS', 'Console output buffer reset');
    });
  }

  /* --------------------------------------------------------------------------
     12. DETAIL INSPECTION MODAL
     -------------------------------------------------------------------------- */
  function openModal(title, category, data) {
    currentModalPayload = data;
    if (modalTitle) modalTitle.textContent = title;
    if (modalCategoryBadge) modalCategoryBadge.textContent = category;
    if (modalBodyContent) {
      modalBodyContent.innerHTML = `
        <pre class="modal-json-pre">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      `;
    }
    if (inspectModal) {
      inspectModal.classList.add('open');
      inspectModal.setAttribute('aria-hidden', 'false');
    }
  }

  function closeModal() {
    if (inspectModal) {
      inspectModal.classList.remove('open');
      inspectModal.setAttribute('aria-hidden', 'true');
    }
    currentModalPayload = null;
  }

  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
  if (modalDoneBtn) modalDoneBtn.addEventListener('click', closeModal);
  if (inspectModal) {
    inspectModal.addEventListener('click', (e) => {
      if (e.target === inspectModal) closeModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inspectModal && inspectModal.classList.contains('open')) {
      closeModal();
    }
  });

  if (modalCopyJsonBtn) {
    modalCopyJsonBtn.addEventListener('click', () => {
      if (currentModalPayload) {
        copyToClipboard(JSON.stringify(currentModalPayload, null, 2), 'JSON data');
      }
    });
  }

  /* --------------------------------------------------------------------------
     13. WINDOW CONTROLS & AUTO REFRESH
     -------------------------------------------------------------------------- */
  const winBtnMinimize = document.getElementById('winBtnMinimize');
  const winBtnMaximize = document.getElementById('winBtnMaximize');
  const winBtnClose = document.getElementById('winBtnClose');
  const retroAsciiCard = document.querySelector('.retro-ascii-card');

  if (winBtnMinimize && retroAsciiCard) {
    winBtnMinimize.addEventListener('click', () => {
      retroAsciiCard.classList.toggle('collapsed');
      const isCollapsed = retroAsciiCard.classList.contains('collapsed');
      winBtnMinimize.title = isCollapsed ? 'Expand specs banner' : 'Minimize specs banner';
    });
  }

  if (winBtnMaximize) {
    winBtnMaximize.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        winBtnMaximize.textContent = '❐';
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
        winBtnMaximize.textContent = '□';
      }
    });
  }

  if (winBtnClose) {
    winBtnClose.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  function setupAutoRefresh() {
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    if (!autoRefreshSelect) return;
    const intervalSeconds = parseInt(autoRefreshSelect.value, 10);

    if (intervalSeconds > 0) {
      if (refreshPulseDot) refreshPulseDot.classList.add('active');
      autoRefreshTimer = setInterval(() => {
        if (!getAccessToken()) return;
        loadOverview();
        if (activeTab === 'sessions') loadSessions();
        else if (activeTab === 'feedback') loadFeedbacks();
        else if (activeTab === 'users') loadUsers();
        else if (activeTab === 'devices') loadDevices();
      }, intervalSeconds * 1000);
    } else {
      if (refreshPulseDot) refreshPulseDot.classList.remove('active');
    }
  }

  if (autoRefreshSelect) {
    autoRefreshSelect.addEventListener('change', () => {
      setupAutoRefresh();
      showToast(
        `Auto-refresh: ${autoRefreshSelect.options[autoRefreshSelect.selectedIndex].text}`,
        ICONS.check,
      );
    });
  }

  /* --------------------------------------------------------------------------
     14. AUTH FLOW
     -------------------------------------------------------------------------- */
  if (authServer) {
    authServer.value = serverBase();
  }

  async function bootstrapAfterLogin(identity) {
    hideAuthGate();
    if (adminIdentity) adminIdentity.textContent = identity || 'operator';
    if (adminSignOutBtn) adminSignOutBtn.hidden = false;

    loadOverview();
    loadSessions();
    setupAutoRefresh();
    executePing();
  }

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (authError) authError.style.display = 'none';

      const email = String(authEmail?.value || '').trim().toLowerCase();
      const password = String(authPassword?.value || '');
      const server = normalizeServer(authServer?.value || '');
      if (!email || !password) {
        if (authError) {
          authError.textContent = 'Email and master password are required.';
          authError.style.display = 'block';
        }
        return;
      }
      if (!server) {
        if (authError) {
          authError.textContent = 'Enter the sync server URL (for example http://localhost:8080).';
          authError.style.display = 'block';
        }
        return;
      }

      localStorage.setItem(SERVER_KEY, server);
      if (authSubmit) {
        authSubmit.disabled = true;
        authSubmit.textContent = 'Signing in…';
      }

      try {
        const user = await signIn(email, password);
        await bootstrapAfterLogin(user?.email || email);
      } catch (err) {
        clearSession();
        if (authError) {
          authError.textContent = err?.message || 'Sign-in failed.';
          authError.style.display = 'block';
        }
      } finally {
        if (authSubmit) {
          authSubmit.disabled = false;
          authSubmit.textContent = 'Sign in';
        }
      }
    });
  }

  if (adminSignOutBtn) {
    adminSignOutBtn.addEventListener('click', async () => {
      const rt = sessionStorage.getItem(RT_KEY);
      if (rt) {
        fetch(`${serverBase()}/v1/auth/logout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        }).catch(() => {});
      }
      clearSession();
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      if (adminIdentity) adminIdentity.textContent = '';
      adminSignOutBtn.hidden = true;
      showAuthGate('Signed out.');
    });
  }

  /* --------------------------------------------------------------------------
     15. INITIAL BOOTSTRAP
     -------------------------------------------------------------------------- */
  initTheme();

  if (!getAccessToken()) {
    showAuthGate('');
  } else {
    if (adminIdentity) {
      adminIdentity.textContent = sessionStorage.getItem(EMAIL_KEY) || 'operator';
    }
    if (adminSignOutBtn) adminSignOutBtn.hidden = false;
    bootstrapAfterLogin(sessionStorage.getItem(EMAIL_KEY));
  }
});
