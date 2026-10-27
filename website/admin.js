// Switch Admin Console — Retro Workstation Controller
document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = 'http://localhost:8080/v1/admin';

  // State
  let overviewData = null;
  let allFeedbacks = [];
  let allUsers = [];
  let allDevices = [];
  let activeFeedbackFilter = 'all';

  // Elements
  const systemClock = document.getElementById('systemClock');
  const specNodeVersion = document.getElementById('specNodeVersion');
  const specPlatform = document.getElementById('specPlatform');
  const specUptime = document.getElementById('specUptime');
  const specMemory = document.getElementById('specMemory');
  const dbStatusLabel = document.getElementById('dbStatusLabel');

  const gaugeUsersCount = document.getElementById('gaugeUsersCount');
  const gaugeUsersRecent = document.getElementById('gaugeUsersRecent');
  const gaugeSessionsCount = document.getElementById('gaugeSessionsCount');
  const gaugeDevicesCount = document.getElementById('gaugeDevicesCount');
  const gaugeFeedbackCount = document.getElementById('gaugeFeedbackCount');
  const gaugeFeedbackBreakdown = document.getElementById('gaugeFeedbackBreakdown');

  const tabBadgeFeedback = document.getElementById('tabBadgeFeedback');
  const tabBadgeUsers = document.getElementById('tabBadgeUsers');
  const tabBadgeDevices = document.getElementById('tabBadgeDevices');

  const countPillBug = document.getElementById('countPillBug');
  const countPillImprovement = document.getElementById('countPillImprovement');
  const countPillSuggestion = document.getElementById('countPillSuggestion');

  const feedbackTableBody = document.getElementById('feedbackTableBody');
  const usersTableBody = document.getElementById('usersTableBody');
  const devicesTableBody = document.getElementById('devicesTableBody');
  const retroTerminalConsole = document.getElementById('retroTerminalConsole');

  const feedbackSearchInput = document.getElementById('feedbackSearchInput');
  const userSearchInput = document.getElementById('userSearchInput');
  const deviceSearchInput = document.getElementById('deviceSearchInput');

  // Clock Ticker
  function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    if (systemClock) systemClock.textContent = `${h}:${m}:${s}`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // Format Helpers
  function formatUptime(seconds) {
    if (!seconds && seconds !== 0) return '0m';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hrs}h ${mins}m`;
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'N/A';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoStr;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Append line to terminal
  function appendTerminalLog(level, msg) {
    if (!retroTerminalConsole) return;
    const line = document.createElement('div');
    line.className = 'terminal-line';
    const ts = new Date().toLocaleTimeString();
    line.innerHTML = `<span class="t-ts">[${ts}]</span> <span class="t-lvl-${level}">[${level}]</span> ${escapeHtml(msg)}`;
    retroTerminalConsole.insertBefore(line, retroTerminalConsole.firstChild);
  }

  // Fetch Overview Data
  async function loadOverview() {
    try {
      const res = await fetch(`${API_BASE}/overview`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      overviewData = await res.json();

      applyOverview(overviewData);
      appendTerminalLog('STATUS', 'Fetched real-time overview telemetry from server');
    } catch (err) {
      console.warn('[switch-admin] API fetch failed, falling back to local archive/demo state:', err);
      if (dbStatusLabel) dbStatusLabel.textContent = 'LOCAL_CACHE';
      loadLocalFallbackData();
    }
  }

  function applyOverview(data) {
    if (!data) return;

    // Specs
    if (specNodeVersion && data.system) specNodeVersion.textContent = data.system.nodeVersion || 'v22.x';
    if (specPlatform && data.system) specPlatform.textContent = `${data.system.platform || 'x64'} ${data.system.arch || ''}`;
    if (specUptime && data.system) specUptime.textContent = formatUptime(data.system.uptimeSeconds);
    if (specMemory && data.system) specMemory.textContent = `${data.system.memoryRssMb || 0} MB`;

    // Counts
    const counts = data.counts || {};
    if (gaugeUsersCount) gaugeUsersCount.textContent = counts.users ?? '--';
    if (gaugeSessionsCount) gaugeSessionsCount.textContent = counts.sessions ?? '--';
    if (gaugeDevicesCount) gaugeDevicesCount.textContent = counts.devices ?? '--';
    if (gaugeFeedbackCount) gaugeFeedbackCount.textContent = counts.feedbacks ?? '--';

    if (tabBadgeFeedback) tabBadgeFeedback.textContent = counts.feedbacks ?? '0';
    if (tabBadgeUsers) tabBadgeUsers.textContent = counts.users ?? '0';
    if (tabBadgeDevices) tabBadgeDevices.textContent = counts.devices ?? '0';

    const byType = counts.feedbackByType || { bug: 0, improvement: 0, suggestion: 0 };
    if (countPillBug) countPillBug.textContent = byType.bug || '0';
    if (countPillImprovement) countPillImprovement.textContent = byType.improvement || '0';
    if (countPillSuggestion) countPillSuggestion.textContent = byType.suggestion || '0';

    if (gaugeFeedbackBreakdown) {
      gaugeFeedbackBreakdown.textContent = `${byType.bug || 0} bugs • ${(byType.improvement || 0) + (byType.suggestion || 0)} ideas`;
    }

    // Populate initial logs
    if (data.logs && retroTerminalConsole && retroTerminalConsole.children.length === 0) {
      data.logs.forEach(l => appendTerminalLog(l.level, l.msg));
    }
  }

  // Load Feedbacks
  async function loadFeedbacks() {
    try {
      const res = await fetch(`${API_BASE}/feedbacks`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allFeedbacks = data.items || [];
      renderFeedbacks();
    } catch (err) {
      // Local fallback
      allFeedbacks = JSON.parse(localStorage.getItem('switch_feedback_history') || '[]');
      if (allFeedbacks.length === 0 && overviewData?.recentFeedbacks) {
        allFeedbacks = overviewData.recentFeedbacks;
      }
      renderFeedbacks();
    }
  }

  function renderFeedbacks() {
    if (!feedbackTableBody) return;
    const query = (feedbackSearchInput ? feedbackSearchInput.value : '').toLowerCase().trim();

    const filtered = allFeedbacks.filter(item => {
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
      feedbackTableBody.innerHTML = `
        <tr>
          <td colspan="6" class="table-empty-row">No feedback records found matching active filter.</td>
        </tr>`;
      return;
    }

    feedbackTableBody.innerHTML = filtered.map(item => {
      const id = item._id || item.id || 'N/A';
      const shortId = typeof id === 'string' ? id.slice(-6) : 'item';
      const status = item.status || 'open';
      const type = item.type || 'bug';

      const typeBadgeClass = `type-badge-${type}`;
      const typeEmoji = type === 'bug' ? '🐞' : type === 'improvement' ? '🚀' : '💡';

      const statusBadgeClass = `status-${status}`;
      const statusLabel = status.toUpperCase();

      const emailText = item.email ? escapeHtml(item.email) : '<span style="color:#9ca3af;">(Anonymous)</span>';
      const ipText = item.ip ? `<span class="table-mono-text" style="color:#6b7280; font-size:10px;">${escapeHtml(item.ip)}</span>` : '';

      return `
        <tr data-id="${escapeHtml(id)}">
          <td>
            <span class="type-badge-retro ${typeBadgeClass}">
              <span>${typeEmoji}</span>
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
            ${ipText}
          </td>
          <td class="table-mono-text">${formatDate(item.createdAt || item.timestamp)}</td>
          <td>
            <span class="status-badge-retro ${statusBadgeClass}">${statusLabel}</span>
          </td>
          <td>
            <div class="table-actions-cell">
              ${status !== 'resolved' ? `<button type="button" class="retro-btn retro-btn-sm action-resolve-btn" data-id="${escapeHtml(id)}" title="Mark Resolved">✓ Resolve</button>` : `<button type="button" class="retro-btn retro-btn-sm action-reopen-btn" data-id="${escapeHtml(id)}" title="Reopen">↺ Open</button>`}
              <button type="button" class="retro-btn retro-btn-sm retro-btn-danger action-delete-btn" data-id="${escapeHtml(id)}" title="Purge Record">✕</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    // Attach row action handlers
    feedbackTableBody.querySelectorAll('.action-resolve-btn').forEach(btn => {
      btn.addEventListener('click', () => updateFeedbackStatus(btn.dataset.id, 'resolved'));
    });
    feedbackTableBody.querySelectorAll('.action-reopen-btn').forEach(btn => {
      btn.addEventListener('click', () => updateFeedbackStatus(btn.dataset.id, 'open'));
    });
    feedbackTableBody.querySelectorAll('.action-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => deleteFeedback(btn.dataset.id));
    });
  }

  // Update feedback status
  async function updateFeedbackStatus(id, newStatus) {
    try {
      const res = await fetch(`${API_BASE}/feedbacks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      appendTerminalLog('UPDATE', `Feedback ${id.slice(-6)} updated to status: ${newStatus}`);
    } catch (err) {
      console.warn('[switch-admin] backend patch failed, updating local state:', err);
    }

    // Local state sync
    allFeedbacks = allFeedbacks.map(f => {
      if ((f._id === id) || (f.id === id)) {
        return { ...f, status: newStatus };
      }
      return f;
    });
    renderFeedbacks();
  }

  // Delete feedback
  async function deleteFeedback(id) {
    if (!confirm(`Purge feedback record ${id.slice(-6)} from database?`)) return;

    try {
      const res = await fetch(`${API_BASE}/feedbacks/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      appendTerminalLog('DELETE', `Feedback ${id.slice(-6)} purged successfully`);
    } catch (err) {
      console.warn('[switch-admin] delete API failed, updating local state:', err);
    }

    allFeedbacks = allFeedbacks.filter(f => (f._id !== id) && (f.id !== id));
    renderFeedbacks();
    loadOverview();
  }

  // Load Users
  async function loadUsers() {
    try {
      const res = await fetch(`${API_BASE}/users`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allUsers = data.items || [];
      renderUsers();
    } catch (err) {
      if (overviewData?.recentUsers) {
        allUsers = overviewData.recentUsers;
      }
      renderUsers();
    }
  }

  function renderUsers() {
    if (!usersTableBody) return;
    const query = (userSearchInput ? userSearchInput.value : '').toLowerCase().trim();

    const filtered = allUsers.filter(u => {
      if (!query) return true;
      const email = (u.email || '').toLowerCase();
      const id = (u._id || '').toLowerCase();
      return email.includes(query) || id.includes(query);
    });

    if (filtered.length === 0) {
      usersTableBody.innerHTML = `<tr><td colspan="4" class="table-empty-row">No users matching search query.</td></tr>`;
      return;
    }

    usersTableBody.innerHTML = filtered.map(u => {
      const id = u._id || 'N/A';
      const hasKey = u.publicKey ? '<span class="status-badge-retro status-resolved">RSA-4096 SIGNED</span>' : '<span class="status-badge-retro status-reviewed">SEALED CLIENT</span>';
      return `
        <tr>
          <td class="table-mono-text" style="color:#4b5563;">${escapeHtml(id)}</td>
          <td><strong>${escapeHtml(u.email || 'N/A')}</strong></td>
          <td>${hasKey}</td>
          <td class="table-mono-text">${formatDate(u.createdAt)}</td>
        </tr>
      `;
    }).join('');
  }

  // Load Devices
  async function loadDevices() {
    try {
      const res = await fetch(`${API_BASE}/devices`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      allDevices = data.items || [];
      renderDevices();
    } catch (err) {
      if (overviewData?.recentDevices) {
        allDevices = overviewData.recentDevices;
      }
      renderDevices();
    }
  }

  function renderDevices() {
    if (!devicesTableBody) return;
    const query = (deviceSearchInput ? deviceSearchInput.value : '').toLowerCase().trim();

    const filtered = allDevices.filter(d => {
      if (!query) return true;
      const name = (d.name || '').toLowerCase();
      const devId = (d.deviceId || '').toLowerCase();
      const sysId = (d.systemId || '').toLowerCase();
      return name.includes(query) || devId.includes(query) || sysId.includes(query);
    });

    if (filtered.length === 0) {
      devicesTableBody.innerHTML = `<tr><td colspan="4" class="table-empty-row">No connected devices found.</td></tr>`;
      return;
    }

    devicesTableBody.innerHTML = filtered.map(d => {
      const sysId = d.systemId ? `<span class="table-mono-text">${escapeHtml(d.systemId)}</span>` : '<span style="color:#9ca3af;">standalone</span>';
      return `
        <tr>
          <td class="table-mono-text" style="color:#4b5563;">${escapeHtml(d.deviceId || 'N/A')}</td>
          <td><strong>${escapeHtml(d.name || 'Unnamed Device')}</strong></td>
          <td>${sysId}</td>
          <td class="table-mono-text">${formatDate(d.lastSeenAt || d.createdAt)}</td>
        </tr>
      `;
    }).join('');
  }

  // Tab Switching
  const tabButtons = document.querySelectorAll('.retro-tab-btn');
  const tabPanes = {
    feedback: document.getElementById('tabPaneFeedback'),
    users: document.getElementById('tabPaneUsers'),
    devices: document.getElementById('tabPaneDevices'),
    terminal: document.getElementById('tabPaneTerminal')
  };

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      tabButtons.forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
      });

      Object.keys(tabPanes).forEach(k => {
        if (tabPanes[k]) {
          tabPanes[k].classList.toggle('hidden', k !== tab);
        }
      });

      // Lazy loads
      if (tab === 'users') loadUsers();
      if (tab === 'devices') loadDevices();
    });
  });

  // Filter Buttons for Feedback
  document.querySelectorAll('.retro-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.retro-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeFeedbackFilter = pill.dataset.filter || 'all';
      renderFeedbacks();
    });
  });

  // Search input listeners
  if (feedbackSearchInput) feedbackSearchInput.addEventListener('input', renderFeedbacks);
  if (userSearchInput) userSearchInput.addEventListener('input', renderUsers);
  if (deviceSearchInput) deviceSearchInput.addEventListener('input', renderDevices);

  // Refresh buttons
  const refreshFeedbackBtn = document.getElementById('refreshFeedbackBtn');
  if (refreshFeedbackBtn) refreshFeedbackBtn.addEventListener('click', () => {
    loadFeedbacks();
    loadOverview();
  });
  const refreshUsersBtn = document.getElementById('refreshUsersBtn');
  if (refreshUsersBtn) refreshUsersBtn.addEventListener('click', loadUsers);
  const refreshDevicesBtn = document.getElementById('refreshDevicesBtn');
  if (refreshDevicesBtn) refreshDevicesBtn.addEventListener('click', loadDevices);

  // Terminal actions
  const pingServerBtn = document.getElementById('pingServerBtn');
  if (pingServerBtn) {
    pingServerBtn.addEventListener('click', async () => {
      appendTerminalLog('HEARTBEAT', 'Sending diagnostic ping to /v1/admin/action/ping...');
      try {
        const start = performance.now();
        const res = await fetch(`${API_BASE}/action/ping`, { method: 'POST' });
        const latency = Math.round(performance.now() - start);
        if (res.ok) {
          appendTerminalLog('STATUS', `Pong received from Switch Core API! Latency: ${latency}ms`);
        } else {
          appendTerminalLog('UPDATE', `Ping returned status HTTP ${res.status}`);
        }
      } catch (err) {
        appendTerminalLog('UPDATE', `Ping error: ${err.message}`);
      }
    });
  }

  const exportAuditBtn = document.getElementById('exportAuditBtn');
  if (exportAuditBtn) {
    exportAuditBtn.addEventListener('click', () => {
      const dump = {
        exportedAt: new Date().toISOString(),
        overview: overviewData,
        feedbacks: allFeedbacks,
        usersCount: allUsers.length,
        devicesCount: allDevices.length
      };
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `switch-audit-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      appendTerminalLog('INFO', 'Audit snapshot exported to client JSON file');
    });
  }

  const clearLogBtn = document.getElementById('clearLogBtn');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      if (retroTerminalConsole) retroTerminalConsole.innerHTML = '';
      appendTerminalLog('STATUS', 'Console output buffer reset');
    });
  }

  // Workstation Window Controls
  const winBtnMinimize = document.getElementById('winBtnMinimize');
  const winBtnMaximize = document.getElementById('winBtnMaximize');
  const winBtnClose = document.getElementById('winBtnClose');
  const retroAsciiCard = document.querySelector('.retro-ascii-card');

  if (winBtnMinimize && retroAsciiCard) {
    winBtnMinimize.addEventListener('click', () => {
      retroAsciiCard.classList.toggle('collapsed');
      const isCollapsed = retroAsciiCard.classList.contains('collapsed');
      winBtnMinimize.title = isCollapsed ? 'Expand System Specs Banner' : 'Minimize / Collapse System Specs Banner';
      appendTerminalLog('INFO', isCollapsed ? 'System banner minimized for compact view' : 'System banner expanded');
    });
  }

  if (winBtnMaximize) {
    winBtnMaximize.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
        winBtnMaximize.textContent = '❐';
        winBtnMaximize.title = 'Exit Fullscreen';
      } else {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
        winBtnMaximize.textContent = '□';
        winBtnMaximize.title = 'Toggle Fullscreen Display';
      }
    });

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) {
        winBtnMaximize.textContent = '□';
      } else {
        winBtnMaximize.textContent = '❐';
      }
    });
  }

  if (winBtnClose) {
    winBtnClose.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  // Fallback demo data if backend offline
  function loadLocalFallbackData() {
    applyOverview({
      timestamp: new Date().toISOString(),
      system: {
        uptimeSeconds: 3600,
        nodeVersion: 'v22.15.0',
        platform: 'win32',
        arch: 'x64',
        memoryRssMb: 58.4,
        memoryHeapUsedMb: 16.2
      },
      counts: {
        users: 325,
        sessions: 257,
        devices: 96,
        shares: 59,
        feedbacks: 4,
        feedbackByType: { bug: 1, improvement: 2, suggestion: 1 }
      }
    });

    loadFeedbacks();
  }

  // Initial Load
  loadOverview();
  loadFeedbacks();

  // Polling every 12s for fresh stats
  setInterval(loadOverview, 12000);
});
