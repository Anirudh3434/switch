import { isConsented, giveConsent, PROTOCOL } from '../lib/consent.js';
import {
  parseJwt,
  parseJwtHeader,
  isJwt,
  isAuthToken,
  login,
  getServerUrl,
  setServerUrl,
} from '../lib/auth.js';
import {
  getBrowserLogoSvg,
  getBrowserSpriteHtml,
  getBrowserSpriteClass,
} from '../lib/browser-icons.js';
import { getRegistrableDomain, hostMatches } from '../lib/domain.js';

const CH = chrome;

const $ = (id) => document.getElementById(id);

let statusTimer = null;
const status = (text, kind = '', durationMs = 1500) => {
  const el = $('status');
  if (!el) return;
  if (statusTimer) {
    clearTimeout(statusTimer);
    statusTimer = null;
  }
  el.textContent = text;
  el.className = `toast-status ${kind}`;

  if (text) {
    const isOngoing = text.endsWith('…') || text.endsWith('...');
    const timeout = isOngoing ? 6000 : durationMs;
    statusTimer = setTimeout(() => {
      el.textContent = '';
      el.className = 'toast-status';
    }, timeout);
  }
};

let allCookies = [];
let currentFilter = 'all'; // 'all' | 'auth' | 'secure' | 'session'
let selectedDomain = '';
let selectedDeviceFilter = 'current'; // 'current' | 'all' | '<deviceId>'
let searchQuery = '';
let authMode = 'login'; // 'login' | 'register'
let currentUser = null;
let openDomainGroups = new Set();
let areAllGroupsOpen = false;
let showAllDomains = false;

// Device Management & Cross-Device Sessions
let currentDeviceId = null;
let currentSystemId = null;
let currentDeviceInfo = null;
let userDevices = [];
let allDevices = [];
let remoteSessions = [];
let activeSwaps = {}; // map of rootDomain -> SwapRecord
const syncedDeviceIds = new Set();

// Theme State
let currentTheme = 'dark';

const send = (msg) => CH.runtime.sendMessage(msg);

/**
 * Ask for host access while we still have the click's user gesture.
 * Dynamic content scripts cannot be registered for an origin we do not have
 * permission for, and Chrome requires the request to be user-initiated.
 */
async function ensureHostAccess(host) {
  const clean = String(host || '').replace(/^\.+/, '').toLowerCase().trim();
  if (!clean) return false;
  try {
    const origins = [`*://*.${clean}/*`];
    const already = await CH.permissions.contains({ origins });
    if (already) return true;
    return await CH.permissions.request({ origins });
  } catch (e) {
    console.warn('[switch] host permission request failed:', e?.message || e);
    return false;
  }
}

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const isLight = theme === 'light';

  document.querySelectorAll('.theme-toggle-btn').forEach((btn) => {
    const darkIcon = btn.querySelector('.theme-icon-dark');
    const lightIcon = btn.querySelector('.theme-icon-light');
    if (darkIcon) darkIcon.classList.toggle('hidden', isLight);
    if (lightIcon) lightIcon.classList.toggle('hidden', !isLight);
    btn.title = isLight ? 'Switch to dark theme' : 'Switch to light theme';
  });
}

async function initTheme() {
  try {
    const { theme } = await CH.storage.local.get('theme');
    if (theme) {
      applyTheme(theme);
    } else {
      const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      applyTheme(prefersLight ? 'light' : 'dark');
    }
  } catch {
    applyTheme('dark');
  }

  const toggleHandler = async () => {
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(nextTheme);
    await CH.storage.local.set({ theme: nextTheme }).catch(() => { });
  };

  $('theme-toggle-btn')?.addEventListener('click', toggleHandler);
  $('theme-toggle-btn-auth')?.addEventListener('click', toggleHandler);
  $('theme-toggle-btn-otp')?.addEventListener('click', toggleHandler);
  $('theme-toggle-btn-forgot')?.addEventListener('click', toggleHandler);
  $('theme-toggle-btn-reset')?.addEventListener('click', toggleHandler);
}

/**
 * Triggers the DevTools Inspect Sidebar & Suction Warp Animation on the active page.
 */
async function triggerInspectSyncAnimation(domain, cookies) {
  try {
    const tabs = await CH.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id || !tab.url || !tab.url.startsWith('http')) return;

    const targetDomain = domain || new URL(tab.url).hostname;
    try {
      await CH.tabs.sendMessage(tab.id, {
        type: 'PLAY_SYNC_INSPECT_ANIMATION',
        domain: targetDomain,
        cookies: cookies || [],
      });
    } catch {
      // Tab might have been open prior to extension reload
      if (CH.scripting && CH.scripting.executeScript) {
        await CH.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/inspect-sync-animation.js'],
        }).catch(() => { });
        await CH.tabs.sendMessage(tab.id, {
          type: 'PLAY_SYNC_INSPECT_ANIMATION',
          domain: targetDomain,
          cookies: cookies || [],
        }).catch(() => { });
      }
    }
  } catch (e) {
    console.debug('[switch] triggerInspectSyncAnimation error:', e);
  }
}

/**
 * Filter out localhost, 127.0.0.1, ::1, and local development domains.
 */
function isLocalhost(domain) {
  if (!domain) return false;
  const d = String(domain).replace(/^\./, '').toLowerCase().trim();
  return (
    d === 'localhost' ||
    d === '127.0.0.1' ||
    d === '::1' ||
    d.endsWith('.localhost') ||
    d.startsWith('localhost:')
  );
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanDomain(d) {
  if (!d) return 'host-only';
  return d.replace(/^\./, '').trim();
}

function getRootDomain(domain) {
  if (!domain || domain === 'host-only') return '';
  return getRegistrableDomain(cleanDomain(domain));
}

/**
 * Local, deterministic favicon placeholder.
 *
 * We deliberately do not call a third-party favicon service: that would leak
 * every site the user inspects to Google, from an extension whose entire pitch
 * is not leaking browsing data.
 */
function getFaviconUrl(domain) {
  if (!domain || domain === 'host-only') return '';
  const d = cleanDomain(domain);
  const letter = (d[0] || '?').toUpperCase();
  let hash = 0;
  for (let i = 0; i < d.length; i++) hash = (hash * 31 + d.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="hsl(${hue} 55% 42%)"/>` +
    `<text x="16" y="22" font-family="system-ui,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function formatRelativeTime(timestamp) {
  if (!timestamp) return 'Just now';
  const diff = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Active just now';
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days}d ago`;
}

// SVG Icons
const ICON_KEY = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-1.5 1.5L16 7l-2-2-4 4-2-2L2 13l4 4 1-1 4-4 2 2 1.5-1.5L16 11l5-5-1.5-1.5z"/></svg>`;
const ICON_COOKIE = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="8" cy="9" r="1.5" fill="currentColor"/><circle cx="15" cy="8" r="1" fill="currentColor"/><circle cx="10" cy="14" r="1" fill="currentColor"/><circle cx="15" cy="14" r="1.5" fill="currentColor"/></svg>`;
const ICON_LOCK = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const ICON_CODE = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`;

// ---------------- CONFIRMATION MODAL ----------------
let pendingDeleteAction = null;

function updateModalScopeUI(scope) {
  const isPurge = scope === 'purge';
  const optLogout = $('scope-option-logout');
  const optPurge = $('scope-option-purge');
  if (optLogout) optLogout.classList.toggle('active', !isPurge);
  if (optPurge) optPurge.classList.toggle('active', isPurge);

  const cloudTitle = $('checklist-cloud-title');
  const cloudDesc = $('checklist-cloud-desc');
  if (cloudTitle) cloudTitle.textContent = 'Cloud Vault:';
  if (cloudDesc) {
    cloudDesc.textContent = isPurge
      ? 'Permanently erased from cloud database.'
      : 'Preserved in cloud so you can auto-sign in anytime.';
  }

  const actionText = $('confirm-modal-action-text');
  if (actionText) {
    actionText.textContent = isPurge ? 'Delete Everywhere' : 'Log Out This Browser';
  }
}

function showDeleteConfirmationModal({
  title,
  domain,
  cookieCount,
  isSingleCookie,
  cookieName,
  onConfirm,
}) {
  const modal = $('confirm-modal');
  if (!modal) return;

  $('confirm-modal-title').textContent = title || 'Delete Session & Tokens?';
  $('confirm-modal-domain').textContent = domain || '';
  $('confirm-count-cookies').textContent = isSingleCookie
    ? `Cookie "${cookieName}"`
    : `${cookieCount} cookies`;

  const scopePicker = $('confirm-scope-picker');
  const cloudItem = $('checklist-cloud-item');
  if (isSingleCookie) {
    if (scopePicker) scopePicker.classList.add('hidden');
    if (cloudItem) cloudItem.classList.add('hidden');
    $('confirm-modal-action-text').textContent = 'Delete Cookie';
  } else {
    if (scopePicker) scopePicker.classList.remove('hidden');
    if (cloudItem) cloudItem.classList.remove('hidden');
    const radioLogout = document.querySelector('input[name="delete-scope"][value="logout"]');
    if (radioLogout) radioLogout.checked = true;
    updateModalScopeUI('logout');
  }

  pendingDeleteAction = onConfirm;
  modal.classList.remove('hidden');
}

function hideDeleteConfirmationModal() {
  const modal = $('confirm-modal');
  if (modal) modal.classList.add('hidden');
  pendingDeleteAction = null;
}

document.querySelectorAll('input[name="delete-scope"]').forEach((radio) => {
  radio.addEventListener('change', (e) => {
    updateModalScopeUI(e.target.value);
  });
});

$('confirm-modal-close')?.addEventListener('click', hideDeleteConfirmationModal);
$('confirm-modal-cancel')?.addEventListener('click', hideDeleteConfirmationModal);
$('confirm-modal-submit')?.addEventListener('click', async () => {
  if (typeof pendingDeleteAction === 'function') {
    const action = pendingDeleteAction;
    const isPurge = document.querySelector('input[name="delete-scope"]:checked')?.value === 'purge';
    hideDeleteConfirmationModal();
    await action({ deleteServer: isPurge });
  }
});

// ---------------- LOGOUT CONFIRMATION MODAL ----------------
function showLogoutConfirmationModal() {
  const modal = $('logout-confirm-modal');
  if (modal) modal.classList.remove('hidden');
}

function hideLogoutConfirmationModal() {
  const modal = $('logout-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

$('logout-modal-close')?.addEventListener('click', hideLogoutConfirmationModal);
$('logout-modal-cancel')?.addEventListener('click', hideLogoutConfirmationModal);

$('logout-confirm-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'logout-confirm-modal') hideLogoutConfirmationModal();
});

// ---------------- PREVIOUS-INSTALL MERGE MODAL ----------------
$('device-merge-close')?.addEventListener('click', hideDeviceMergeModal);
$('device-merge-cancel')?.addEventListener('click', hideDeviceMergeModal);
$('device-merge-confirm')?.addEventListener('click', async () => {
  const device = pendingMergeDevice;
  hideDeviceMergeModal();
  if (device) await mergeDeviceIntoCurrent(device);
});
$('device-merge-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'device-merge-modal') hideDeviceMergeModal();
});

$('confirm-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'confirm-modal') hideDeleteConfirmationModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideLogoutConfirmationModal();
    hideDeleteConfirmationModal();
    hideDeviceMergeModal();
  }
});

// ---------------- SCREEN NAVIGATION ----------------
// Step 1: Login -> Step 2: Consent -> Step 3: Main App

async function applyRememberedEmail() {
  try {
    const { rememberEmail, rememberMe } = await CH.storage.local.get(['rememberEmail', 'rememberMe']);
    if (rememberEmail && $('auth-email')) {
      $('auth-email').value = rememberEmail;
      if ($('auth-remember-me')) {
        $('auth-remember-me').checked = rememberMe !== false;
      }
    }
  } catch { }
}

let pendingAuthData = { email: '', password: '', serverUrl: '', verificationToken: '' };
let pendingResetData = { email: '', verificationToken: '', serverUrl: '' };
let otpPurpose = 'account registration';
let otpCountdownTimer = null;

function showScreen(screenId) {
  $('view-login').classList.toggle('hidden', screenId !== 'login');
  $('view-forgot')?.classList.toggle('hidden', screenId !== 'forgot');
  $('view-otp')?.classList.toggle('hidden', screenId !== 'otp');
  $('view-reset-password')?.classList.toggle('hidden', screenId !== 'reset-password');
  $('view-consent').classList.toggle('hidden', screenId !== 'consent');
  $('view-app').classList.toggle('hidden', screenId !== 'app');
  if (screenId === 'login') {
    applyRememberedEmail();
    checkActiveRateLimit();
  } else if (screenId === 'forgot') {
    checkActiveRateLimit();
  }
}

let rateLimitTimer = null;

function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  if (mins > 0) {
    return `${mins}m ${secs.toString().padStart(2, '0')}s`;
  }
  return `${secs}s`;
}

function clearAuthRateLimit() {
  if (rateLimitTimer) {
    clearInterval(rateLimitTimer);
    rateLimitTimer = null;
  }
  CH.storage.local.remove(['authRateLimitUntil', 'rateLimitTargetBtn']).catch(() => {});
  const btn = $('auth-submit-btn');
  if (btn) {
    btn.disabled = false;
    btn.classList.remove('btn-rate-limited');
    btn.textContent = authMode === 'login' ? 'Sign in' : 'Send Verification Code';
    btn.removeAttribute('title');
    btn.ondblclick = null;
  }
  const forgotBtn = $('forgot-submit-btn');
  if (forgotBtn) {
    forgotBtn.disabled = false;
    forgotBtn.classList.remove('btn-rate-limited');
    forgotBtn.textContent = 'Send Reset Code';
    forgotBtn.removeAttribute('title');
    forgotBtn.ondblclick = null;
  }
}

function startAuthRateLimitTimer(seconds = 60, targetBtnId = 'auth-submit-btn') {
  const btn = $(targetBtnId) || $('auth-submit-btn');

  if (rateLimitTimer) {
    clearInterval(rateLimitTimer);
    rateLimitTimer = null;
  }

  const expireAt = Date.now() + Math.max(1, seconds) * 1000;
  CH.storage.local.set({ authRateLimitUntil: expireAt, rateLimitTargetBtn: targetBtnId }).catch(() => {});

  const getOriginalText = () => {
    if (targetBtnId === 'forgot-submit-btn') return 'Send Reset Code';
    return authMode === 'login' ? 'Sign in' : 'Send Verification Code';
  };

  const update = () => {
    const remainingMs = expireAt - Date.now();
    const remainingSecs = Math.ceil(remainingMs / 1000);

    if (remainingSecs <= 0) {
      clearAuthRateLimit();
      status('Rate limit expired. You can try again.', 'ok', 3000);
      return;
    }

    const formatted = formatCountdown(remainingSecs);

    if (btn) {
      btn.disabled = true;
      btn.classList.add('btn-rate-limited');
      btn.title = 'Rate limit in effect (Double-click to reset in development)';
      btn.innerHTML = `<span class="timer-clock-icon">⏱</span> Retry in ${formatted}`;
      btn.ondblclick = () => {
        clearAuthRateLimit();
        status('Cooldown reset.', 'ok', 2000);
      };
    }
  };

  update();
  rateLimitTimer = setInterval(update, 1000);
}

async function checkActiveRateLimit() {
  try {
    const { authRateLimitUntil, rateLimitTargetBtn } = await CH.storage.local.get(['authRateLimitUntil', 'rateLimitTargetBtn']);
    if (authRateLimitUntil && authRateLimitUntil > Date.now()) {
      const remainingSecs = Math.ceil((authRateLimitUntil - Date.now()) / 1000);
      startAuthRateLimitTimer(remainingSecs, rateLimitTargetBtn || 'auth-submit-btn');
    } else if (authRateLimitUntil) {
      await CH.storage.local.remove(['authRateLimitUntil', 'rateLimitTargetBtn']).catch(() => {});
    }
  } catch {}
}

function startOtpCountdown(seconds = 60) {
  clearInterval(otpCountdownTimer);
  let remaining = seconds;
  const badge = $('otp-timer-badge');
  const countdownEl = $('otp-countdown');
  const resendBtn = $('otp-resend-btn');

  if (badge) badge.classList.remove('hidden');
  if (resendBtn) resendBtn.classList.add('hidden');
  if (countdownEl) countdownEl.textContent = `${remaining}s`;

  otpCountdownTimer = setInterval(() => {
    remaining--;
    if (countdownEl) countdownEl.textContent = `${remaining}s`;
    if (remaining <= 0) {
      clearInterval(otpCountdownTimer);
      if (badge) badge.classList.add('hidden');
      if (resendBtn) resendBtn.classList.remove('hidden');
    }
  }, 1000);
}

function clearOtpInputs() {
  const inputs = document.querySelectorAll('.otp-digit-input');
  inputs.forEach((input) => {
    input.value = '';
    input.classList.remove('filled');
  });
  if (inputs[0]) inputs[0].focus();
}

function getEnteredOtp() {
  const inputs = document.querySelectorAll('.otp-digit-input');
  let code = '';
  inputs.forEach((input) => {
    code += input.value.trim();
  });
  return code;
}

function setupOtpDigitInputs() {
  const inputs = document.querySelectorAll('.otp-digit-input');
  inputs.forEach((input, index) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value.replace(/[^0-9]/g, '');
      e.target.value = val ? val[val.length - 1] : '';
      if (val) {
        input.classList.add('filled');
        if (index < inputs.length - 1) {
          inputs[index + 1].focus();
        }
      } else {
        input.classList.remove('filled');
      }

      // If all 6 digits entered, auto-verify
      if (getEnteredOtp().length === 6) {
        $('otp-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        inputs[index - 1].focus();
        inputs[index - 1].value = '';
        inputs[index - 1].classList.remove('filled');
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData)
        .getData('text')
        .replace(/[^0-9]/g, '')
        .slice(0, 6);
      if (!pasteData) return;
      pasteData.split('').forEach((char, i) => {
        if (inputs[i]) {
          inputs[i].value = char;
          inputs[i].classList.add('filled');
        }
      });
      const nextFocus = Math.min(pasteData.length, inputs.length - 1);
      inputs[nextFocus].focus();
      if (pasteData.length === 6) {
        $('otp-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  });
}

function switchAppTab(tabName) {
  $('tab-btn-cookies').classList.toggle('active', tabName === 'cookies');
  $('tab-btn-cookies').setAttribute('aria-selected', tabName === 'cookies' ? 'true' : 'false');

  $('tab-btn-devices').classList.toggle('active', tabName === 'devices');
  $('tab-btn-devices').setAttribute('aria-selected', tabName === 'devices' ? 'true' : 'false');

  $('tab-btn-account').classList.toggle('active', tabName === 'account');
  $('tab-btn-account').setAttribute('aria-selected', tabName === 'account' ? 'true' : 'false');

  $('tab-cookies').classList.toggle('hidden', tabName !== 'cookies');
  $('tab-cookies').classList.toggle('active', tabName === 'cookies');

  $('tab-devices').classList.toggle('hidden', tabName !== 'devices');
  $('tab-devices').classList.toggle('active', tabName === 'devices');

  $('tab-account').classList.toggle('hidden', tabName !== 'account');
  $('tab-account').classList.toggle('active', tabName === 'account');

  if (tabName === 'devices') {
    loadDevicesAndRemoteSessions();
  }

  if (tabName === 'account') {
    updateAccountTab();
  }
}

// ---------------- STEP 1: LOGIN FIRST ----------------

$('auth-mode-login').onclick = () => {
  authMode = 'login';
  $('auth-mode-login').classList.add('active');
  $('auth-mode-register').classList.remove('active');
  $('auth-options-row')?.classList.remove('hidden');
  if (!rateLimitTimer) {
    $('auth-submit-btn').textContent = 'Sign in';
    $('auth-submit-btn').disabled = false;
    $('auth-submit-btn').classList.remove('btn-rate-limited');
  }
};

$('auth-mode-register').onclick = () => {
  authMode = 'register';
  $('auth-mode-register').classList.add('active');
  $('auth-mode-login').classList.remove('active');
  $('auth-options-row')?.classList.add('hidden');
  if (!rateLimitTimer) {
    $('auth-submit-btn').textContent = 'Send Verification Code';
    $('auth-submit-btn').disabled = false;
    $('auth-submit-btn').classList.remove('btn-rate-limited');
  }
};

$('toggle-password-visibility')?.addEventListener('click', () => {
  const pwdInput = $('auth-password');
  const showIcon = document.querySelector('.eye-icon-show');
  const hideIcon = document.querySelector('.eye-icon-hide');
  if (!pwdInput) return;
  if (pwdInput.type === 'password') {
    pwdInput.type = 'text';
    showIcon?.classList.add('hidden');
    hideIcon?.classList.remove('hidden');
  } else {
    pwdInput.type = 'password';
    showIcon?.classList.remove('hidden');
    hideIcon?.classList.add('hidden');
  }
});

$('auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;

  // The server URL is visible and editable on this screen. We never fall back
  // to a hidden production host: whatever is shown is what is used.
  let serverUrl = String($('auth-server-url')?.value || '').trim();
  if (!serverUrl) {
    return status('Enter your sync server URL before signing in.', 'err');
  }
  try {
    serverUrl = await setServerUrl(serverUrl);
  } catch (err) {
    return status(`Invalid sync server URL: ${err.message}`, 'err');
  }

  const rememberMe = $('auth-remember-me')?.checked ?? true;
  if (authMode === 'login') {
    if (rememberMe) {
      await CH.storage.local.set({ rememberEmail: email, rememberMe: true });
    } else {
      await CH.storage.local.remove(['rememberEmail', 'rememberMe']);
    }
  }

  // REGISTRATION FLOW WITH GMAIL SMTP EMAIL OTP VERIFICATION
  if (authMode === 'register') {
    if (password.length < 8) {
      return status('Master password must be at least 8 characters long.', 'err');
    }

    otpPurpose = 'account registration';
    if ($('otp-screen-title')) $('otp-screen-title').textContent = 'Verify Email';
    if ($('otp-screen-subtitle')) $('otp-screen-subtitle').innerHTML = `Code sent to <strong id="otp-target-email" class="otp-email-text">${email}</strong>`;

    status('Sending 6-digit verification code via Gmail SMTP…');
    try {
      const otpRes = await send({
        type: 'AUTH_SEND_OTP',
        email,
        purpose: 'account registration',
        serverUrl,
      });

      if (!otpRes.ok) {
        const isRateLimited = otpRes.code === 'rate_limited' || String(otpRes.error || '').includes('rate_limited') || String(otpRes.message || '').includes('rate_limited');
        if (isRateLimited) {
          const waitSeconds = Number(otpRes.retryAfterSeconds) || 60;
          startAuthRateLimitTimer(waitSeconds, 'auth-submit-btn');
          return status(`Rate limited: Please wait ${formatCountdown(waitSeconds)} before requesting a code.`, 'err', 5000);
        }
        return status(`Failed to send verification code: ${otpRes.message || otpRes.error}`, 'err');
      }

      pendingAuthData = { email, password, serverUrl, verificationToken: '' };
      if ($('otp-target-email')) $('otp-target-email').textContent = email;
      showScreen('otp');
      clearOtpInputs();
      setupOtpDigitInputs();
      startOtpCountdown(otpRes.cooldown || 60);

      if (otpRes.simulated && otpRes.devOtp) {
        status(`Code sent! (Dev code: ${otpRes.devOtp})`, 'ok');
      } else {
        status('Verification code sent! Please check your Gmail inbox.', 'ok');
      }
    } catch (err) {
      return status(`Could not send OTP: ${err.message}`, 'err');
    }
    return;
  }

  // LOGIN FLOW
  status('Signing in…');
  const res = await send({ type: 'AUTH_LOGIN', email, password, serverUrl });
  if (!res.ok) {
    const isRateLimited = res.code === 'rate_limited' || String(res.error || '').includes('rate_limited') || String(res.error || '').includes('Too many requests');
    if (isRateLimited) {
      const waitSeconds = Number(res.retryAfterSeconds) || 60;
      startAuthRateLimitTimer(waitSeconds, 'auth-submit-btn');
      return status(`Rate limited: Please wait ${formatCountdown(waitSeconds)} before trying again.`, 'err', 5000);
    }
    return status(`Login failed: ${res.error}`, 'err');
  }

  status(`Signed in as ${res.user.email}!`, 'ok');
  currentUser = res.user;
  $('auth-password').value = '';

  await initCurrentDevice();
  await checkConsentAndProceed();
};

// ---------------- STEP 1.3: FORGOT PASSWORD ----------------
$('auth-forgot-pwd-btn')?.addEventListener('click', () => {
  const currentEmail = $('auth-email')?.value.trim();
  if (currentEmail && $('forgot-email')) {
    $('forgot-email').value = currentEmail;
  }
  showScreen('forgot');
});

$('forgot-back-btn')?.addEventListener('click', () => {
  showScreen('login');
});

$('forgot-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  if (!email) return status('Please enter your account email.', 'err');

  const serverUrl = String($('auth-server-url')?.value || '').trim() || (await getServerUrl());

  status('Sending password reset code via Gmail SMTP…');
  try {
    const res = await send({
      type: 'AUTH_FORGOT_PASSWORD',
      email,
      serverUrl,
    });

    if (!res.ok) {
      const isRateLimited = res.code === 'rate_limited' || String(res.error || '').includes('rate_limited') || String(res.message || '').includes('rate_limited');
      if (isRateLimited) {
        const waitSeconds = Number(res.retryAfterSeconds) || 60;
        startAuthRateLimitTimer(waitSeconds, 'forgot-submit-btn');
        return status(`Rate limited: Please wait ${formatCountdown(waitSeconds)} before requesting another code.`, 'err', 5000);
      }
      return status(res.message || res.error || 'Failed to send reset code.', 'err');
    }

    otpPurpose = 'password reset';
    pendingResetData = { email, verificationToken: '', serverUrl };
    pendingAuthData = { email, password: '', serverUrl, verificationToken: '' };

    if ($('otp-target-email')) $('otp-target-email').textContent = email;
    if ($('otp-screen-title')) $('otp-screen-title').textContent = 'Reset Password';
    if ($('otp-screen-subtitle')) $('otp-screen-subtitle').innerHTML = `Code sent to <strong class="otp-email-text">${email}</strong>`;

    showScreen('otp');
    clearOtpInputs();
    setupOtpDigitInputs();
    startOtpCountdown(res.cooldown || 60);

    if (res.simulated && res.devOtp) {
      status(`Reset code sent! (Dev code: ${res.devOtp})`, 'ok');
    } else {
      status('Password reset code sent! Please check your Gmail inbox.', 'ok');
    }
  } catch (err) {
    status(`Could not send reset code: ${err.message}`, 'err');
  }
});

// ---------------- STEP 1.5: OTP VERIFICATION ACTIONS ----------------

$('otp-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const otp = getEnteredOtp();
  if (otp.length !== 6) {
    return status('Please enter all 6 digits of the verification code.', 'err');
  }

  status('Verifying code…');
  try {
    const verifyRes = await send({
      type: 'AUTH_VERIFY_OTP',
      email: pendingAuthData.email,
      otp,
      purpose: otpPurpose,
      serverUrl: pendingAuthData.serverUrl,
    });

    if (!verifyRes.ok) {
      return status(verifyRes.message || `Verification failed: ${verifyRes.error}`, 'err');
    }

    clearInterval(otpCountdownTimer);

    // If this is password reset flow, proceed to enter new master password
    if (otpPurpose === 'password reset') {
      pendingResetData.verificationToken = verifyRes.verificationToken;
      status('Email verified! Please set your new master password.', 'ok');
      showScreen('reset-password');
      if ($('reset-new-password')) {
        $('reset-new-password').value = '';
        $('reset-new-password').focus();
      }
      if ($('reset-confirm-password')) $('reset-confirm-password').value = '';
      return;
    }

    // Otherwise account registration flow:
    pendingAuthData.verificationToken = verifyRes.verificationToken;
    status('Email verified! Creating encrypted vault account…');

    const regRes = await send({
      type: 'AUTH_REGISTER',
      email: pendingAuthData.email,
      password: pendingAuthData.password,
      verificationToken: verifyRes.verificationToken,
      otp,
      serverUrl: pendingAuthData.serverUrl,
    });

    if (!regRes.ok) {
      return status(`Registration failed: ${regRes.error || regRes.message}`, 'err');
    }

    status(`Account created and verified! Signed in as ${regRes.user.email}`, 'ok');
    currentUser = regRes.user;
    $('auth-password').value = '';

    await initCurrentDevice();
    await checkConsentAndProceed();
  } catch (err) {
    status(`Verification error: ${err.message}`, 'err');
  }
});

$('otp-resend-btn')?.addEventListener('click', async () => {
  if (!pendingAuthData.email) return;
  status('Resending verification code via Gmail SMTP…');
  try {
    const res = await send({
      type: otpPurpose === 'password reset' ? 'AUTH_FORGOT_PASSWORD' : 'AUTH_SEND_OTP',
      email: pendingAuthData.email,
      purpose: otpPurpose,
      serverUrl: pendingAuthData.serverUrl,
    });
    if (res.ok) {
      status(res.simulated ? `Code sent! (Dev OTP: ${res.devOtp})` : 'New verification code sent to your email!', 'ok');
      startOtpCountdown(res.cooldown || 60);
      clearOtpInputs();
    } else {
      status(`Failed to resend code: ${res.message || res.error}`, 'err');
    }
  } catch (err) {
    status(`Failed to resend code: ${err.message}`, 'err');
  }
});

$('otp-paste-btn')?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    const digits = text.replace(/[^0-9]/g, '').slice(0, 6);
    if (!digits) {
      return status('No numeric code found in clipboard.', 'err');
    }
    const inputs = document.querySelectorAll('.otp-digit-input');
    digits.split('').forEach((char, i) => {
      if (inputs[i]) {
        inputs[i].value = char;
        inputs[i].classList.add('filled');
      }
    });
    const nextFocus = Math.min(digits.length, inputs.length - 1);
    if (inputs[nextFocus]) inputs[nextFocus].focus();
    if (digits.length === 6) {
      $('otp-form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    } else {
      status(`Pasted ${digits.length} digits from clipboard.`, 'ok');
    }
  } catch {
    status('Please paste directly into the box with Ctrl+V.', 'err');
  }
});

$('otp-back-btn')?.addEventListener('click', () => {
  clearInterval(otpCountdownTimer);
  if (otpPurpose === 'password reset') {
    showScreen('forgot');
  } else {
    showScreen('login');
  }
});

// ---------------- STEP 1.6: RESET PASSWORD ACTIONS ----------------

function toggleInputPasswordVisibility(pwdInput, btnId) {
  const btn = $(btnId);
  const showIcon = btn?.querySelector('.eye-icon-show');
  const hideIcon = btn?.querySelector('.eye-icon-hide');
  if (!pwdInput) return;
  if (pwdInput.type === 'password') {
    pwdInput.type = 'text';
    showIcon?.classList.add('hidden');
    hideIcon?.classList.remove('hidden');
  } else {
    pwdInput.type = 'password';
    showIcon?.classList.remove('hidden');
    hideIcon?.classList.add('hidden');
  }
}

$('toggle-reset-new-pwd')?.addEventListener('click', () => {
  toggleInputPasswordVisibility($('reset-new-password'), 'toggle-reset-new-pwd');
});

$('toggle-reset-confirm-pwd')?.addEventListener('click', () => {
  toggleInputPasswordVisibility($('reset-confirm-password'), 'toggle-reset-confirm-pwd');
});

$('reset-cancel-btn')?.addEventListener('click', () => {
  showScreen('login');
});

$('reset-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPassword = $('reset-new-password').value;
  const confirmPassword = $('reset-confirm-password').value;

  if (newPassword.length < 8) {
    return status('New master password must be at least 8 characters long.', 'err');
  }

  if (newPassword !== confirmPassword) {
    return status('Master passwords do not match. Please verify both fields.', 'err');
  }

  status('Updating master password & resetting vault key…');
  try {
    const res = await send({
      type: 'AUTH_RESET_PASSWORD',
      email: pendingResetData.email,
      newPassword,
      verificationToken: pendingResetData.verificationToken,
      serverUrl: pendingResetData.serverUrl,
    });

    if (!res.ok) {
      return status(`Password reset failed: ${res.message || res.error}`, 'err');
    }

    status('Master password successfully reset! Welcome back.', 'ok');
    currentUser = res.user;
    $('reset-new-password').value = '';
    $('reset-confirm-password').value = '';

    await initCurrentDevice();
    await checkConsentAndProceed();
  } catch (err) {
    status(`Password reset error: ${err.message}`, 'err');
  }
});

// ---------------- STEP 2: CONSENT FORM ----------------

const consentCheckbox = $('consent-checkbox');
const consentBtn = $('give-consent-btn');

if (consentCheckbox && consentBtn) {
  consentCheckbox.addEventListener('change', () => {
    consentBtn.disabled = !consentCheckbox.checked;
  });
}

$('give-consent-btn').onclick = async () => {
  if (consentCheckbox && !consentCheckbox.checked) {
    status('You must accept the terms to continue.', 'err');
    return;
  }
  status('Saving consent…');
  try {
    await giveConsent();
    status('Consent granted.', 'ok');
    await enterMainApp();
  } catch (e) {
    status(`Failed to save consent: ${e?.message || e}`, 'err');
  }
};

async function checkConsentAndProceed() {
  const consented = await isConsented().catch(() => false);
  if (!consented) {
    showScreen('consent');
    // Ensure checkbox is unchecked and button disabled
    const cb = $('consent-checkbox');
    const btn = $('give-consent-btn');
    if (cb) cb.checked = false;
    if (btn) btn.disabled = true;
  } else {
    await enterMainApp();
  }
}

// ---------------- STEP 3: MAIN APP ----------------

async function updateAccountTab() {
  if (currentUser) {
    const email = currentUser.email || 'user@example.com';
    const emailEl = $('account-user-email');
    if (emailEl) emailEl.textContent = email;

    const initialsEl = $('account-avatar-initials');
    if (initialsEl) initialsEl.textContent = email[0].toUpperCase();

    const uidEl = $('account-user-id');
    if (uidEl) uidEl.textContent = currentUser.userId || currentUser.id || 'usr_active';
  }

  try {
    const serverUrl = await getServerUrl();
    const { vaultKeyRaw } = await CH.storage.session.get('vaultKeyRaw');
    const vaultKeyDerived = Array.isArray(vaultKeyRaw) && vaultKeyRaw.length === 32;

    const serverEl = $('account-server-url');
    if (serverEl) serverEl.textContent = serverUrl || 'not configured';

    const vaultStatusEl = $('account-vault-status');
    if (vaultStatusEl) {
      if (vaultKeyDerived) {
        vaultStatusEl.textContent = 'Unlocked & in memory';
        vaultStatusEl.style.color = 'var(--signal-secure)';
      } else {
        vaultStatusEl.textContent = 'Locked (key needed)';
        vaultStatusEl.style.color = 'var(--signal-alert)';
      }
    }

    const linkedEl = $('account-linked-count');
    if (linkedEl) linkedEl.textContent = `${userDevices.length || 1} active`;

    const syncedEl = $('account-synced-count');
    if (syncedEl) syncedEl.textContent = `${remoteSessions.length || 0} domain(s)`;
  } catch (e) {
    console.debug('[switch] updateAccountTab error:', e);
  }
}

async function enterMainApp() {
  showScreen('app');
  switchAppTab('cookies');

  await updateAccountTab();
  await initSettingsForm();

  await initCurrentDevice();
  await checkVaultKeySyncStatus();
  await loadAllBrowserCookies();
  await loadDevicesAndRemoteSessions();
  await maybeOfferDeviceMerge().catch((e) =>
    console.debug('[switch] device merge prompt failed:', e),
  );
  await checkActiveTabAndRenderBanner();
  updateHomeDashboard();

  // Pull only. Opening the popup must never upload anything; uploads are an
  // explicit Save/Sync action (or opt-in auto-sync, which the user must turn on
  // in Settings).
  if (currentUser) {
    loadDevicesAndRemoteSessions().catch((e) =>
      console.debug('[switch] refresh on open failed:', e),
    );
  }
}

// Refreshing focus pulls new remote sessions; it does not push local ones.
window.addEventListener('focus', () => {
  if (currentUser && currentDeviceId) {
    loadDevicesAndRemoteSessions()
      .then(async () => {
        await loadAllBrowserCookies();
        await updateAccountTab();
      })
      .catch(() => {});
  }
});

async function checkVaultKeySyncStatus() {
  const banner = $('vault-key-sync-banner');
  if (!banner) return;
  const { vaultKeyDerived } = await CH.storage.local.get('vaultKeyDerived');
  if (!vaultKeyDerived && currentUser) {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ---------------- DEVICE MANAGEMENT ----------------

/**
 * True when another account record has the same coarse browser + OS as this
 * install. This is only a *prompt* heuristic, never an automatic merge: two
 * different machines can legitimately look identical.
 */
function deviceLooksLikeThisBrowser(device) {
  if (!device || device.deviceId === currentDeviceId) return false;
  const other = device.browserInfo || {};
  const mine = currentDeviceInfo?.browserInfo || {};
  if (!other.browser || !mine.browser) return false;
  if (String(other.browser).toLowerCase() !== String(mine.browser).toLowerCase()) return false;
  if (other.os && mine.os && other.os !== mine.os) return false;
  return true;
}

let pendingMergeDevice = null;

function showDeviceMergeModal(device) {
  const modal = $('device-merge-modal');
  if (!modal || !device?.deviceId) return;

  pendingMergeDevice = device;

  const box = $('device-merge-candidate');
  if (box) {
    box.textContent = '';

    const title = document.createElement('strong');
    title.textContent = device.name || 'Previous device';

    const meta = document.createElement('span');
    const domainCount = remoteSessions.filter((s) => s.deviceId === device.deviceId).length;
    meta.textContent = `${formatRelativeTime(device.lastSeenAt)} · ${domainCount} synced domain${domainCount === 1 ? '' : 's'}`;

    box.append(title, meta);
  }

  modal.classList.remove('hidden');
}

function hideDeviceMergeModal() {
  $('device-merge-modal')?.classList.add('hidden');
  pendingMergeDevice = null;
}

async function maybeOfferDeviceMerge() {
  if (!currentUser || !currentDeviceId) return;

  const { deviceMergePromptedFor } = await CH.storage.local.get('deviceMergePromptedFor');
  const promptKey = `${currentUser.id || currentUser.email || 'user'}:${currentDeviceId}`;
  if (deviceMergePromptedFor === promptKey) return;

  const candidate = userDevices
    .filter((d) => d.deviceId !== currentDeviceId && deviceLooksLikeThisBrowser(d))
    .sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0))[0];

  if (!candidate) return;

  // One automatic prompt per account + install. The Devices tab keeps an
  // explicit Merge action for every candidate, so "Keep separate" is not a
  // dead end.
  await CH.storage.local.set({ deviceMergePromptedFor: promptKey });
  showDeviceMergeModal(candidate);
}

async function mergeDeviceIntoCurrent(device) {
  if (!device?.deviceId) return;

  status(`Merging ${device.name || 'previous install'} into this browser…`);
  try {
    const res = await send({ type: 'DEVICE_ADOPT', deviceId: device.deviceId });
    if (!res?.ok) throw new Error(res?.error || 'device merge failed');

    status(
      `✓ Merged previous install. ${(Number(res.movedSessions) || 0) + (Number(res.mergedSessions) || 0)} session(s) kept.`,
      'ok',
      4000,
    );

    await initCurrentDevice();
    await loadDevicesAndRemoteSessions();
    await updateAccountTab();
  } catch (e) {
    status(`Merge failed: ${e?.message || e}`, 'err');
    // The target may have been revoked from another device; refresh so the
    // stale card does not keep offering a merge.
    await loadDevicesAndRemoteSessions().catch(() => {});
  }
}

async function initCurrentDevice() {
  try {
    const devRes = await send({ type: 'DEVICE_GET_CURRENT' });
    if (devRes?.deviceId) {
      currentDeviceId = devRes.deviceId;
      currentSystemId = devRes.systemId || null;
      currentDeviceInfo = devRes;

      const idEl = $('current-device-id');
      if (idEl) idEl.textContent = devRes.deviceId;

      const sysIdEl = $('current-system-id');
      if (sysIdEl) sysIdEl.textContent = devRes.systemId || 'sys_local';

      const nameEl = $('current-device-name');
      if (nameEl) nameEl.textContent = devRes.name;

      const browserEl = $('current-device-browser');
      if (browserEl) {
        browserEl.textContent = `${devRes.browserInfo?.browser || 'Browser'} ${devRes.browserInfo?.browserMajorVersion || ''}`.trim();
      }

      const osEl = $('current-device-os');
      if (osEl) {
        osEl.textContent = devRes.browserInfo?.os || 'Desktop';
      }

      const browserName = devRes.browserInfo?.browser || devRes.name || 'Chrome';
      const iconEl = $('current-device-icon');
      if (iconEl) {
        iconEl.innerHTML = getBrowserSpriteHtml(browserName, { sizeClass: 'size-md' });
      }

    }

    // Ensure device is registered in backend collection
    if (currentUser) {
      await send({ type: 'DEVICE_REGISTER' }).catch(() => { });
    }
  } catch (e) {
    console.warn('[switch] initCurrentDevice error:', e);
  }
}

async function loadDevicesAndRemoteSessions() {
  try {
    const [devicesRes, sessionsRes, swapsRes] = await Promise.all([
      send({ type: 'DEVICE_LIST' }).catch(() => ({ items: [] })),
      send({ type: 'SYNC_PULL_SESSIONS' }).catch(() => ({ sessions: [] })),
      send({ type: 'GET_ALL_SWAP_BACKUPS' }).catch(() => ({ activeSwaps: {} })),
    ]);

    userDevices = devicesRes?.items || [];
    remoteSessions = (sessionsRes?.sessions || []).filter((s) => !isLocalhost(s.host));
    activeSwaps = swapsRes?.activeSwaps || swapsRes?.backups || {};

    populateDeviceFilter();
    populateDomainFilter();
    updateMetrics();
    renderDevicesTab();
    renderCookieFeed();
    updateHomeDashboard();
  } catch (e) {
    console.warn('[switch] loadDevicesAndRemoteSessions failed:', e);
  }
}

function renderDevicesTab() {
  const listEl = $('devices-other-list');
  const emptyEl = $('devices-other-empty');
  const badgeEl = $('devices-count-badge');
  if (!listEl) return;

  listEl.innerHTML = '';

  // Other devices (exclude current device). Until the current id is known,
  // showing every row as "other" would offer a merge of the current device into
  // itself, which the server correctly rejects.
  const otherDevices = currentDeviceId
    ? userDevices.filter((d) => d.deviceId !== currentDeviceId)
    : [];

  if (badgeEl) {
    badgeEl.textContent = userDevices.length;
    badgeEl.classList.toggle('hidden', userDevices.length <= 1);
  }

  if (otherDevices.length === 0) {
    emptyEl?.classList.remove('hidden');
    return;
  }

  emptyEl?.classList.add('hidden');

  for (const device of otherDevices) {
    // Find sessions belonging to this device
    const deviceSessions = remoteSessions.filter((s) => s.deviceId === device.deviceId);

    const card = document.createElement('div');
    card.className = 'other-device-card';

    // Header
    const header = document.createElement('div');
    header.className = 'device-header';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'device-icon-wrap';
    const otherBrowser = device.browserInfo?.browser || device.name || 'Browser';
    iconWrap.innerHTML = getBrowserSpriteHtml(otherBrowser, { sizeClass: 'size-md' });

    const infoMain = document.createElement('div');
    infoMain.className = 'device-info-main';

    const headerTop = document.createElement('div');
    headerTop.className = 'device-header-top';

    const title = document.createElement('span');
    title.className = 'device-title';
    title.textContent = device.name || 'Remote Device';
    title.title = device.name || 'Remote Device';

    const timeBadge = document.createElement('span');
    timeBadge.className = 'badge badge-cyan';
    timeBadge.textContent = formatRelativeTime(device.lastSeenAt);

    headerTop.append(title, timeBadge);

    // The old fallback compared OS + platform, but `platform` is never
    // uploaded, so every same-OS device was labelled "Same PC". systemId is
    // random per profile and does not survive an uninstall either. Treat this
    // as a recognition hint only; the user must confirm any merge.
    const isLikelyPreviousInstall = deviceLooksLikeThisBrowser(device);

    const subRow = document.createElement('div');
    subRow.className = 'device-sub-row';

    if (isLikelyPreviousInstall) {
      const samePcBadge = document.createElement('span');
      samePcBadge.className = 'badge badge-same-pc';
      samePcBadge.title =
        'Same browser and OS as this device. If this is an older install of this browser, use Merge.';
      samePcBadge.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>
        </svg>
        <span>Same browser &amp; OS</span>
      `;
      subRow.append(samePcBadge);
    }

    const idWrap = document.createElement('span');
    idWrap.className = 'device-id-wrap';
    const truncatedId = device.deviceId ? `${device.deviceId.slice(0, 16)}…` : '';
    idWrap.innerHTML = `
      <span class="device-id-label">ID:</span>
      <code class="device-id-code" title="${escapeHtml(device.deviceId || '')}">${escapeHtml(truncatedId)}</code>
    `;
    subRow.append(idWrap);

    infoMain.append(headerTop, subRow);
    header.append(iconWrap, infoMain);
    card.appendChild(header);

    // Domains synced by this device
    const domainsBox = document.createElement('div');
    domainsBox.className = 'device-domains-box';

    const domainsHeader = document.createElement('div');
    domainsHeader.className = 'device-domains-header';

    const domainsLabel = document.createElement('div');
    domainsLabel.className = 'device-domains-label';
    domainsLabel.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
      </svg>
      <span>Tokens &amp; Sessions (${deviceSessions.length} domain${deviceSessions.length === 1 ? '' : 's'})</span>
    `;
    domainsHeader.appendChild(domainsLabel);
    domainsBox.appendChild(domainsHeader);

    if (deviceSessions.length > 0) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'device-domain-tags';

      const INITIAL_LIMIT = 6;
      const renderTags = (showAll) => {
        tagsWrap.innerHTML = '';
        tagsWrap.classList.toggle('tags-expanded', showAll);
        const slice = showAll ? deviceSessions : deviceSessions.slice(0, INITIAL_LIMIT);
        for (const s of slice) {
          const tag = document.createElement('span');
          tag.className = 'device-domain-tag';
          tag.title = `${s.host}: ${s.cookies?.length || 0} cookies`;
          tag.innerHTML = `
            <strong>${escapeHtml(cleanDomain(s.host))}</strong>
            <span>(${s.cookies?.length || 0})</span>
          `;
          tagsWrap.appendChild(tag);
        }

        if (deviceSessions.length > INITIAL_LIMIT) {
          const toggleBtn = document.createElement('button');
          toggleBtn.className = 'device-more-domains-btn';
          toggleBtn.innerHTML = showAll
            ? '<span>Show fewer ▲</span>'
            : `<span>+ ${deviceSessions.length - INITIAL_LIMIT} more domains…</span>`;
          toggleBtn.onclick = (e) => {
            e.stopPropagation();
            renderTags(!showAll);
          };
          tagsWrap.appendChild(toggleBtn);
        }
      };

      renderTags(false);
      domainsBox.appendChild(tagsWrap);
    } else {
      const emptyHint = document.createElement('span');
      emptyHint.style.fontSize = '10px';
      emptyHint.style.color = 'var(--text-tertiary)';
      emptyHint.textContent = 'No domain sessions uploaded yet by this device.';
      domainsBox.appendChild(emptyHint);
    }

    card.appendChild(domainsBox);

    // Device Actions Row: [Sync In Tokens] & [Revoke Device (visible once synced)]
    const actionsRow = document.createElement('div');
    actionsRow.className = 'device-card-actions';

    const isAlreadySynced = syncedDeviceIds.has(device.deviceId);

    // 1. Sync In Tokens Button
    const syncInBtn = document.createElement('button');
    syncInBtn.className = `btn btn-sm ${isLikelyPreviousInstall ? 'btn-primary' : 'btn-outline'} device-sync-in-btn`;
    syncInBtn.innerHTML = isAlreadySynced
      ? `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Synced ✓ (Re-sync)
      `
      : `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 3l4 4-4 4"/>
          <path d="M20 7H4"/>
          <path d="M8 21l-4-4 4-4"/>
          <path d="M4 17h16"/>
        </svg>
        Sync In Tokens (${deviceSessions.length})
      `;
    syncInBtn.title = `Adopt all ${deviceSessions.length} domain session tokens from ${escapeHtml(device.name || 'this device')} into this browser`;

    // 2. Revoke Device Button (always visible for any remote/other device)
    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn btn-sm btn-danger-outline device-revoke-btn';
    revokeBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      Revoke
    `;
    revokeBtn.title = `Revoke and disconnect ${escapeHtml(device.name || 'this device')} from your account`;

    if (deviceSessions.length === 0) {
      syncInBtn.disabled = true;
      syncInBtn.classList.add('btn-disabled');
      syncInBtn.title = 'No domain sessions uploaded yet by this device.';
    } else {
      syncInBtn.onclick = async () => {
        await handleSwitchToDevice(device, deviceSessions);
        syncedDeviceIds.add(device.deviceId);
        syncInBtn.innerHTML = `
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Synced ✓ (Re-sync)
        `;
      };
    }

    revokeBtn.onclick = async () => {
      const confirmed = confirm(
        `Are you sure you want to revoke "${device.name || 'this device'}"?\n\nThis will disconnect the device and remove its synced tokens from your cloud account.`
      );
      if (!confirmed) return;

      status(`Revoking ${device.name || 'device'}…`);
      try {
        const res = await send({ type: 'DEVICE_REVOKE', deviceId: device.deviceId });
        if (res && res.error) throw new Error(res.error);
        syncedDeviceIds.delete(device.deviceId);
        userDevices = userDevices.filter((d) => d.deviceId !== device.deviceId);
        renderDevicesTab();
        status(`✓ Revoked access for ${device.name || 'device'}.`, 'ok');
        await loadDevicesAndRemoteSessions();
      } catch (e) {
        status(`Revoke failed: ${e?.message || e}`, 'err');
      }
    };

    // 3. Merge Button (only for a record that looks like this browser)
    if (isLikelyPreviousInstall) {
      const mergeBtn = document.createElement('button');
      mergeBtn.className = 'btn btn-sm btn-secondary device-merge-btn';
      mergeBtn.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 3H5a2 2 0 0 0-2 2v3"/>
          <path d="M3 16v3a2 2 0 0 0 2 2h3"/>
          <path d="M16 3h3a2 2 0 0 1 2 2v3"/>
          <path d="M21 16v3a2 2 0 0 1-2 2h-3"/>
          <path d="M8 12h8"/>
        </svg>
        Merge
      `;
      mergeBtn.title = `Merge this old install into the current browser and remove the duplicate device`;
      mergeBtn.onclick = async () => {
        const confirmed = confirm(
          `Merge "${device.name || 'this device'}" into this browser?\n\nIts synced sessions will move here and the duplicate device record will be removed. Only do this if it is an older install of this browser.`,
        );
        if (!confirmed) return;
        await mergeDeviceIntoCurrent(device);
      };
      actionsRow.append(syncInBtn, mergeBtn, revokeBtn);
    } else {
      actionsRow.append(syncInBtn, revokeBtn);
    }

    card.appendChild(actionsRow);

    listEl.appendChild(card);
  }
}

/**
 * Switch browser sessions to adopt all domain tokens from another device.
 */
async function handleSwitchToDevice(device, sessions) {
  if (!sessions || sessions.length === 0) return;
  status(`Adopting sessions from ${device.name || 'device'}…`);

  try {
    let appliedDomains = 0;
    for (const s of sessions) {
      if (Array.isArray(s.cookies) && s.cookies.length > 0) {
        await send({ type: 'APPLY_COOKIES', cookies: s.cookies });
        appliedDomains++;
      }
    }

    await loadAllBrowserCookies();
    status(`✓ Switched browser to ${device.name}! Adopted ${appliedDomains} domain session(s).`, 'ok');
    switchAppTab('cookies');
  } catch (e) {
    status(`Failed to switch browser sessions: ${e?.message || e}`, 'err');
  }
}

/**
 * Detect if the active browser tab has a cross-device session.
 * If user is already logged in and other device also has a token:
 * Displays a glowing highlighted row with other device, browser logo, and Swap button!
 * If user is on a login/signup form and other device has a token:
 * Displays a highlighted row with other device, browser logo, and Adopt & Sign In button!
 */
async function checkActiveTabAndRenderBanner() {
  const bannerEl = $('active-site-banner');
  const friendlyCardEl = $('home-active-site-card');
  if (!bannerEl) return;

  try {
    const info = await send({ type: 'GET_ACTIVE_TAB_SWAP_INFO' });
    if (!info || !info.ok || (!info.otherDeviceSession && !info.backupSession)) {
      bannerEl.classList.add('hidden');
      bannerEl.innerHTML = '';
      renderHomeActiveSiteCard(info);
      return;
    }

    if (friendlyCardEl) {
      friendlyCardEl.innerHTML = '';
    }

    const { host, pageState, isUserAlreadyLoggedIn, otherDeviceSession, backupSession, hostCookies, tabId } = info;
    const rawDeviceName = otherDeviceSession?.deviceName || backupSession?.swappedWithDevice || 'Other Device';
    const otherBrowser = otherDeviceSession?.browser || rawDeviceName;
    const remoteCount = otherDeviceSession?.cookies?.length || 0;
    const browserSvg = getBrowserLogoSvg(otherBrowser, 24);

    // Clean up device name if verbose (e.g., "Edge 155 on Windows (Laptop)" -> "Edge 155 · Windows")
    const cleanDeviceName = rawDeviceName
      .replace(/\s+on\s+/i, ' · ')
      .replace(/\s*\([^)]*\)/g, '')
      .trim();

    const hasBackup = !!(backupSession && Array.isArray(backupSession.originalCookies) && backupSession.originalCookies.length > 0);
    const backupCount = hasBackup ? backupSession.originalCookies.length : 0;

    bannerEl.className = 'active-site-banner';
    bannerEl.innerHTML = `
      <div class="active-banner-highlight-strip" style="${hasBackup ? 'background: linear-gradient(90deg, #c084fc 0%, #38bdf8 50%, #10b981 100%);' : ''}"></div>
      <div class="active-banner-content">
        <!-- TOP STATUS LINE -->
        <div class="active-banner-top-row">
          <div class="active-banner-indicator">
            <span class="active-pulse-dot" style="${hasBackup ? 'background:#c084fc;box-shadow:0 0 8px #c084fc;' : ''}"></span>
            <span class="active-banner-host">${escapeHtml(host)}</span>
          </div>
          <span class="active-status-badge ${hasBackup ? 'status-swapped' : (isUserAlreadyLoggedIn ? 'status-both' : 'status-remote')}">
            ${hasBackup ? 'Swapped' : (isUserAlreadyLoggedIn ? 'Ready' : 'Available')}
          </span>
        </div>

        <!-- MAIN HERO ROW -->
        <div class="active-banner-main-row">
          <div class="active-banner-device-info">
            <div class="active-banner-browser-icon" title="${escapeHtml(rawDeviceName)}">${browserSvg}</div>
            <div class="active-banner-text">
              <div class="active-banner-title">
                <strong>${escapeHtml(cleanDeviceName)}</strong>
              </div>
              <div class="active-banner-sub">
                ${hasBackup
        ? `<span class="sub-stat-backup">Original: ${escapeHtml(backupSession.originBrowser || 'Local')}</span>`
        : `<span class="sub-stat-remote">${otherDeviceSession?.cookies?.length ? otherDeviceSession.cookies.length + ' tokens synced' : 'Cloud Session'}</span>`}
              </div>
            </div>
          </div>

          <div class="active-banner-actions">
            ${hasBackup ? `
              <button id="active-banner-revert-btn" class="active-banner-btn btn-revert" title="Rollback: Restore exact original session and remove swap record">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                </svg>
                <span>Rollback</span>
              </button>
            ` : (otherDeviceSession ? `
              <button id="active-banner-swap-btn" class="active-banner-btn btn-swap" title="Switch: Switch to session from ${escapeHtml(cleanDeviceName)}">
                <svg class="swap-action-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M16 3l4 4-4 4"/>
                  <path d="M20 7H4"/>
                  <path d="M8 21l-4-4 4-4"/>
                  <path d="M4 17h16"/>
                </svg>
                <span>Switch</span>
              </button>
            ` : '')}

            <button id="active-banner-delete-btn" class="icon-action domain-delete-icon-btn" title="Delete all tokens for ${escapeHtml(host)} from cookies, cloud server, and local storage">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    `;

    bannerEl.classList.remove('hidden');

    // 0. Active Banner Delete Button Handler
    const bannerDeleteBtn = $('active-banner-delete-btn');
    if (bannerDeleteBtn) {
      bannerDeleteBtn.onclick = () => {
        showDeleteConfirmationModal({
          title: `Delete Session for ${host}?`,
          domain: host,
          cookieCount: hostCookies.length,
          isSingleCookie: false,
          onConfirm: async ({ deleteServer } = {}) => {
            status(`Deleting session and tokens for ${host}…`);
            try {
              const res = await send({
                type: 'DELETE_DOMAIN_SESSION',
                host,
                deleteServer: !!deleteServer,
              });
              await loadAllBrowserCookies();
              await loadDevicesAndRemoteSessions();
              const serverMsg = res?.serverDeleted
                ? ' • Cloud vault erased'
                : ' • Cloud vault preserved for auto-sign in';
              status(
                `✓ Removed ${res?.cookiesRemovedCount || 0} cookies & tokens for ${host}${serverMsg}!`,
                'ok'
              );
            } catch (err) {
              status(`Failed to delete ${host}: ${err?.message || err}`, 'err');
            }
          },
        });
      };
    }

    // 1. Revert / Rollback Button Handler
    const revertBtn = $('active-banner-revert-btn');
    if (revertBtn) {
      revertBtn.onclick = async () => {
        revertBtn.disabled = true;
        revertBtn.innerHTML = `<span>Restoring…</span>`;
        status(`Restoring original session for ${host}…`);

        try {
          await send({
            type: 'RESTORE_SWAP_BACKUP',
            host,
            tabId,
          });

          await loadAllBrowserCookies();
          await loadDevicesAndRemoteSessions();

          revertBtn.innerHTML = `<span>✓ Restored!</span>`;
          status(`✓ Restored original session for ${host}! Tab reloaded.`, 'ok');
          setTimeout(() => checkActiveTabAndRenderBanner(), 1500);
        } catch (e) {
          revertBtn.disabled = false;
          revertBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
            <span>Rollback</span>
          `;
          status(`Restore failed: ${e?.message || e}`, 'err');
        }
      };
    }

    // 2. Switch Button Handler
    const swapBtn = $('active-banner-swap-btn');
    if (swapBtn && otherDeviceSession) {
      swapBtn.onclick = async () => {
        swapBtn.disabled = true;
        swapBtn.innerHTML = `<span>Switching…</span>`;
        status(`Switching session for ${host} with ${rawDeviceName}…`);

        try {
          const res = await send({
            type: 'SWAP_ACTIVE_TAB_SESSION',
            host,
            currentCookies: hostCookies,
            remoteCookies: otherDeviceSession.cookies,
            tabId,
            baseVersion: otherDeviceSession.version || 0,
            deviceName: rawDeviceName,
            isInjectOnly: false,
          });

          if (!res || !res.ok) {
            throw new Error((res && res.error) ? String(res.error) : 'Switch failed');
          }

          await loadAllBrowserCookies();
          await loadDevicesAndRemoteSessions();

          swapBtn.innerHTML = `<span>✓ Switched!</span>`;
          status(`✓ Switched session for ${host} with ${rawDeviceName}! Tab reloaded.`, 'ok');
          setTimeout(() => checkActiveTabAndRenderBanner(), 1500);
        } catch (e) {
          swapBtn.disabled = false;
          swapBtn.innerHTML = `
            <svg class="swap-action-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 3l4 4-4 4"/>
              <path d="M20 7H4"/>
              <path d="M8 21l-4-4 4-4"/>
              <path d="M4 17h16"/>
            </svg>
            <span>Switch</span>
          `;
          status(`Switch failed: ${e?.message || e}`, 'err');
        }
      };
    }
  } catch (e) {
    console.warn('[switch] checkActiveTabAndRenderBanner error:', e);
    bannerEl?.classList.add('hidden');
    renderHomeActiveSiteCard(null);
  }
}

/**
 * Render friendly Active Site card for everyday non-technical users on the Home tab.
 */
function renderHomeActiveSiteCard(info) {
  const cardEl = $('home-active-site-card');
  if (!cardEl) return;

  if (!info || !info.ok || !info.host) {
    cardEl.innerHTML = '';
    return;
  }

  const { host, hostCookies } = info;
  const cookieCount = hostCookies?.length || 0;

  cardEl.innerHTML = `
    <div class="active-site-card-friendly">
      <div class="active-site-friendly-left">
        <img class="active-site-favicon" src="${getFaviconUrl(host)}" alt="${escapeHtml(host)}" onerror="this.style.display='none'" />
        <div class="active-site-meta-visual">
          <div class="active-site-host-row">
            <span class="active-site-host-name">${escapeHtml(host)}</span>
            <span class="vchip vchip-tab"><svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Tab</span>
          </div>
          <div class="active-site-chips-row">
            <span class="vchip vchip-cookies" title="${cookieCount} browser cookies">🍪 ${cookieCount}</span>
            <span class="vchip vchip-secure"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Ready</span>
          </div>
        </div>
      </div>
      <div class="active-site-friendly-actions">
        ${cookieCount > 0 ? `
          <button id="active-site-sync-btn" class="btn-outline-cyan" title="Sync this site to encrypted cloud vault">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
            <span>Sync Site</span>
          </button>
        ` : ''}
      </div>
    </div>
  `;

  const syncSiteBtn = $('active-site-sync-btn');
  if (syncSiteBtn) {
    syncSiteBtn.onclick = async () => {
      syncSiteBtn.disabled = true;
      await ensureHostAccess(host);
      syncSiteBtn.innerHTML = `<span>…</span>`;
      status(`Syncing ${host}…`);
      try {
        const res = await send({
          type: 'SYNC_PUSH_DOMAIN',
          host,
          cookies: hostCookies,
        });
        if (res?.results?.[0]?.status === 'conflict') {
          status(
            `Cloud has a newer copy of ${host}. Use Adopt to pull it instead.`,
            'err',
            3200,
          );
          syncSiteBtn.disabled = false;
          syncSiteBtn.innerHTML = `<span>Sync Site</span>`;
          return;
        }
        await loadDevicesAndRemoteSessions();
        status(`✓ Synced ${host}!`, 'ok');
        syncSiteBtn.innerHTML = `<span>✓ Synced</span>`;
      } catch (err) {
        status(`Failed: ${err?.message || err}`, 'err');
        syncSiteBtn.disabled = false;
        syncSiteBtn.innerHTML = `<span>Sync Site</span>`;
      }
    };
  }
}

/**
 * Handle one-click Switch from Home Suggestions.
 */
async function handleSuggestionSwitch(domain, remoteSession) {
  try {
    const tabs = await CH.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    let activeHost = '';
    try {
      if (activeTab?.url) activeHost = new URL(activeTab.url).hostname.replace(/^\./, '').toLowerCase();
    } catch { }

    const root = getRootDomain(domain);
    const isCurrentTabTarget = activeHost && (activeHost === domain || activeHost === root || activeHost.endsWith('.' + domain));

    if (isCurrentTabTarget) {
      const localCookiesForDomain = allCookies.filter((c) => {
        const d = String(c.domain || '').replace(/^\./, '').toLowerCase().trim();
        return d === domain || d === root || domain.endsWith('.' + d);
      });
      await handleSwapDomainSession(domain, localCookiesForDomain, remoteSession);
    } else {
      status(`Applying session for ${domain}…`);
      await send({
        type: 'SWAP_ACTIVE_TAB_SESSION',
        host: domain,
        currentCookies: [],
        remoteCookies: remoteSession.cookies,
        deviceName: remoteSession.deviceName,
        targetDeviceId: remoteSession.deviceId,
        baseVersion: remoteSession.version || 0,
        isInjectOnly: true,
      });
      await CH.tabs.create({ url: `https://${domain}` });
      status(`✓ Switched to ${domain}!`, 'ok');
      await loadAllBrowserCookies();
      await loadDevicesAndRemoteSessions();
    }
  } catch (err) {
    status(`Failed: ${err?.message || err}`, 'err');
  }
}

/**
 * Render smart suggestions on the Home popup view.
 */
function renderHomeSuggestions() {
  const listEl = $('home-suggestions-list');
  const countEl = $('home-suggestions-counter');
  if (!listEl) return;

  listEl.innerHTML = '';
  const suggestions = [];

  // 1. Cross-Device Suggestions from other devices (Highest Priority)
  const otherDeviceSessions = remoteSessions.filter(
    (s) => s.deviceId !== currentDeviceId && Array.isArray(s.cookies) && s.cookies.length > 0
  );

  for (const s of otherDeviceSessions) {
    const host = cleanDomain(s.host);
    if (!host || suggestions.some((item) => item.host === host)) continue;

    const device = userDevices.find((d) => d.deviceId === s.deviceId);
    const deviceName = device?.name || s.deviceName || 'Remote';
    const cleanDevice = deviceName.replace(/\s+on\s+/i, ' · ').replace(/\s*\([^)]*\)/g, '').trim();
    const spriteClass = getBrowserSpriteClass(cleanDevice);

    suggestions.push({
      type: 'remote',
      host,
      badgeHtml: `<span class="browser-sprite-icon ${spriteClass} size-xs"></span> <span>${escapeHtml(cleanDevice)}</span>`,
      badgeClass: 'suggestion-badge-remote',
      actionHtml: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 3l4 4-4 4"/><path d="M20 7H4"/><path d="M8 21l-4-4 4-4"/><path d="M4 17h16"/></svg> <span>Switch</span>`,
      actionClass: 'btn-suggestion-swap',
      session: s,
    });
  }

  // 2. Top Authenticated Sites from local browser
  const localAuthMap = new Map();
  for (const c of allCookies) {
    if (isLocalhost(c.domain)) continue;
    if (isAuthToken(c.name, c.value)) {
      const d = cleanDomain(c.domain);
      localAuthMap.set(d, (localAuthMap.get(d) || 0) + 1);
    }
  }

  const sortedAuthDomains = Array.from(localAuthMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([domain]) => domain);

  for (const host of sortedAuthDomains) {
    if (suggestions.some((item) => item.host === host)) continue;
    if (suggestions.length >= 8) break;

    suggestions.push({
      type: 'local',
      host,
      badgeHtml: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> <span>Vault</span>`,
      badgeClass: 'suggestion-badge-local',
      actionHtml: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg> <span>Open</span>`,
      actionClass: 'btn-suggestion-open',
    });
  }

  if (countEl) {
    countEl.textContent = `${suggestions.length} ready`;
  }

  if (suggestions.length === 0) {
    listEl.innerHTML = `
      <div class="home-suggestions-empty-card">
        <div class="empty-flow-visual">
          <span>🌐</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span>☁️</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span>💻</span>
        </div>
        <div class="empty-card-title">Link another browser to switch</div>
      </div>
    `;
    return;
  }

  for (const item of suggestions) {
    const row = document.createElement('div');
    row.className = 'home-suggestion-item';

    const left = document.createElement('div');
    left.className = 'suggestion-left';

    const img = document.createElement('img');
    img.className = 'suggestion-favicon';
    img.src = getFaviconUrl(item.host);
    img.alt = item.host;
    img.onerror = () => { img.style.display = 'none'; };

    const meta = document.createElement('div');
    meta.className = 'suggestion-meta';

    const domainRow = document.createElement('div');
    domainRow.className = 'suggestion-domain-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'suggestion-domain';
    nameSpan.textContent = item.host;

    const badgeSpan = document.createElement('span');
    badgeSpan.className = item.badgeClass;
    badgeSpan.innerHTML = item.badgeHtml;

    domainRow.appendChild(nameSpan);
    domainRow.appendChild(badgeSpan);
    meta.appendChild(domainRow);

    left.appendChild(img);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'suggestion-actions';

    const btn = document.createElement('button');
    btn.className = item.actionClass;
    btn.innerHTML = item.actionHtml;

    if (item.type === 'remote') {
      btn.onclick = () => handleSuggestionSwitch(item.host, item.session);
    } else {
      btn.onclick = () => {
        CH.tabs.create({ url: `https://${item.host}` });
      };
    }

    actions.appendChild(btn);
    row.appendChild(left);
    row.appendChild(actions);

    listEl.appendChild(row);
  }
}

/**
 * Update the Home Dashboard counts and recommendations.
 */
function updateHomeDashboard() {
  // 1. Current Device Local Domains
  const localDomainSet = new Set();
  for (const c of allCookies) {
    if (c.domain && !isLocalhost(c.domain)) localDomainSet.add(cleanDomain(c.domain));
  }
  const currentDomainsCount = localDomainSet.size;

  // 2. Other Device Remote Domains
  const remoteDomainSet = new Set();
  const otherDeviceSessions = remoteSessions.filter(
    (s) => s.deviceId !== currentDeviceId && Array.isArray(s.cookies) && s.cookies.length > 0
  );
  for (const s of otherDeviceSessions) {
    if (s.host && !isLocalhost(s.host)) {
      remoteDomainSet.add(cleanDomain(s.host));
    }
  }
  const remoteDomainsCount = remoteDomainSet.size;

  // 3. Total Stored Tokens / Cookies Count
  const allTokensCount = allCookies.length;

  // 4. Number Available to Switch (Unique ready cross-device domains)
  const availableToSwitchCount = remoteDomainSet.size;

  // 5. Total Connected Devices
  const devicesCount = userDevices.length || 1;

  // Populate Live Metrics Grid
  const availableEl = $('metric-available-count');
  if (availableEl) availableEl.textContent = availableToSwitchCount;

  const currentEl = $('metric-current-domains-count');
  if (currentEl) currentEl.textContent = currentDomainsCount;

  const tokensEl = $('metric-tokens-count') || $('metric-remote-domains-count');
  if (tokensEl) tokensEl.textContent = allTokensCount;

  const devicesEl = $('metric-devices-count');
  if (devicesEl) devicesEl.textContent = devicesCount;

  // Populate Vault Summary Card
  const domainsCountEl = $('home-vault-domains-count');
  if (domainsCountEl) domainsCountEl.textContent = currentDomainsCount;

  const devicesCountEl = $('home-vault-devices-count');
  if (devicesCountEl) {
    devicesCountEl.textContent = devicesCount;
  }

  renderHomeSuggestions();
}



// ---------------- COOKIES FEED ----------------

async function loadAllBrowserCookies() {
  status('Loading cookies from browser store…');

  let cookies = [];
  try {
    const res = await send({ type: 'GET_ALL_BROWSER_COOKIES' });
    cookies = res?.cookies || [];
  } catch {
    cookies = await CH.cookies.getAll({});
  }

  // Strictly ignore localhost, 127.0.0.1, ::1 tokens
  allCookies = (cookies || []).filter((c) => !isLocalhost(c.domain));
  status(`Loaded ${allCookies.length} cookies from browser store.`, 'ok');

  populateDeviceFilter();
  populateDomainFilter();
  updateMetrics();
  renderCookieFeed();
  checkActiveTabAndRenderBanner();
  updateHomeDashboard();
}

/**
 * Populate Device Selector (This Browser vs All Devices vs Specific Remote Device).
 */
function populateDeviceFilter() {
  const select = $('cookie-device-select');
  if (!select) return;

  const prev = select.value || selectedDeviceFilter || 'current';
  select.innerHTML = '';

  const optCurrent = document.createElement('option');
  optCurrent.value = 'current';
  optCurrent.textContent = `This Browser (${allCookies.length})`;
  select.appendChild(optCurrent);

  const otherDevices = userDevices.filter((d) => d.deviceId !== currentDeviceId);

  if (otherDevices.length > 0 || remoteSessions.length > 0) {
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = `All Devices (Cloud Combined)`;
    select.appendChild(optAll);

    for (const d of otherDevices) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      const isSamePc = !!(d.systemId && currentSystemId && d.systemId === currentSystemId);
      const devSessions = remoteSessions.filter((s) => s.deviceId === d.deviceId);
      const countLabel = devSessions.length > 0
        ? `(${devSessions.length} domain${devSessions.length === 1 ? '' : 's'})`
        : `(0 synced domains)`;
      const pcSuffix = isSamePc ? ' · Local PC' : '';
      opt.textContent = `${d.name || 'Remote Browser'}${pcSuffix} ${countLabel}`;
      select.appendChild(opt);
    }
  }

  if (Array.from(select.options).some((o) => o.value === prev)) {
    select.value = prev;
    selectedDeviceFilter = prev;
  } else {
    select.value = 'current';
    selectedDeviceFilter = 'current';
  }
}

/**
 * Resolve cookies for display based on the selected device filter.
 */
function getActiveCookiesForDisplay() {
  if (selectedDeviceFilter === 'current') {
    return allCookies.map((c) => ({
      ...c,
      _deviceOrigin: 'This Browser',
      _isLocal: true,
    }));
  }

  if (selectedDeviceFilter === 'all') {
    const list = allCookies.map((c) => ({
      ...c,
      _deviceOrigin: 'This Browser',
      _isLocal: true,
    }));

    for (const s of remoteSessions) {
      if (s.deviceId === currentDeviceId) continue;
      const originName = s.deviceName || 'Remote Device';
      for (const rc of s.cookies || []) {
        if (isLocalhost(rc.domain)) continue;
        list.push({
          ...rc,
          _deviceOrigin: originName,
          _deviceId: s.deviceId,
          _isLocal: false,
        });
      }
    }
    return list;
  }

  // Specific remote device selected
  const list = [];
  const targetDevice = userDevices.find((d) => d.deviceId === selectedDeviceFilter);
  const originName = targetDevice?.name || 'Remote Device';
  const targetSessions = remoteSessions.filter((s) => s.deviceId === selectedDeviceFilter);

  for (const s of targetSessions) {
    for (const rc of s.cookies || []) {
      if (isLocalhost(rc.domain)) continue;
      list.push({
        ...rc,
        _deviceOrigin: originName,
        _deviceId: s.deviceId,
        _isLocal: false,
      });
    }
  }
  return list;
}

function populateDomainFilter() {
  const select = $('cookie-domain-select');
  const prevVal = select.value;
  const activeCookies = getActiveCookiesForDisplay();

  const domainCounts = {};
  for (const c of activeCookies) {
    if (isLocalhost(c.domain)) continue;
    const d = cleanDomain(c.domain);
    domainCounts[d] = (domainCounts[d] || 0) + 1;
  }

  const sortedDomains = Object.keys(domainCounts).sort((a, b) => {
    return domainCounts[b] - domainCounts[a] || a.localeCompare(b);
  });

  select.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = `All Domains (${activeCookies.length} cookies)`;
  select.appendChild(optAll);

  for (const d of sortedDomains) {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = `${d} (${domainCounts[d]})`;
    select.appendChild(opt);
  }

  if (prevVal && domainCounts[prevVal]) {
    select.value = prevVal;
    selectedDomain = prevVal;
  } else {
    selectedDomain = '';
  }
}

function updateMetrics() {
  const activeCookies = getActiveCookiesForDisplay();
  const total = activeCookies.length;
  let authCount = 0;
  const domains = new Set();

  for (const c of activeCookies) {
    if (isLocalhost(c.domain)) continue;
    if (isAuthToken(c.name, c.value)) authCount++;
    if (c.domain) domains.add(cleanDomain(c.domain));
  }

  // Update unified filter strip badges
  const pillAll = $('stat-pill-all');
  if (pillAll) pillAll.textContent = `(${total})`;

  const pillAuth = $('stat-pill-auth');
  if (pillAuth) pillAuth.textContent = `(${authCount})`;

  const totalDomainsEl = $('stat-total-domains');
  if (totalDomainsEl) totalDomainsEl.textContent = `${domains.size} domains`;

  // Fallback for legacy elements
  const legacyTotal = $('stat-total-cookies');
  if (legacyTotal) legacyTotal.textContent = `${total} cookies`;
  const legacyAuth = $('stat-auth-cookies');
  if (legacyAuth) legacyAuth.textContent = `${authCount} auth tokens`;

  const badgeEl = $('cookies-count-badge');
  if (badgeEl) badgeEl.textContent = total;
}

function createCookieCard(c) {
  const isAuth = isAuthToken(c.name, c.value);
  const isJwtVal = isJwt(c.value);

  const card = document.createElement('li');
  card.className = `token-card ${isAuth ? 'is-auth-card' : ''}`;

  // Top identity row with icon
  const topRow = document.createElement('div');
  topRow.className = 'token-top-row';

  const identity = document.createElement('div');
  identity.className = 'token-identity';

  // Token icon (Key for auth/jwt, cookie icon for regular)
  const iconSpan = document.createElement('span');
  if (isJwtVal) {
    iconSpan.className = 'token-icon jwt-icon';
    iconSpan.innerHTML = ICON_KEY;
  } else if (isAuth) {
    iconSpan.className = 'token-icon auth-icon';
    iconSpan.innerHTML = ICON_KEY;
  } else {
    iconSpan.className = 'token-icon';
    iconSpan.innerHTML = ICON_COOKIE;
  }
  identity.appendChild(iconSpan);

  const keySpan = document.createElement('span');
  keySpan.className = 'token-key';
  keySpan.textContent = c.name;
  keySpan.title = c.name;
  identity.appendChild(keySpan);

  if (isJwtVal) {
    const jwtPill = document.createElement('span');
    jwtPill.className = 'type-pill type-jwt';
    jwtPill.textContent = 'JWT';
    identity.appendChild(jwtPill);
  } else if (isAuth) {
    const authPill = document.createElement('span');
    authPill.className = 'type-pill type-auth';
    authPill.textContent = 'AUTH';
    identity.appendChild(authPill);
  }

  // Device Origin Badge (when viewing all devices or remote device)
  if (c._deviceOrigin && selectedDeviceFilter !== 'current') {
    const originBadge = document.createElement('span');
    originBadge.className = `type-pill ${c._isLocal ? 'type-local-device' : 'type-remote-device'}`;
    originBadge.textContent = c._deviceOrigin;
    originBadge.title = `Origin: ${c._deviceOrigin}`;
    identity.appendChild(originBadge);
  }

  topRow.appendChild(identity);
  card.appendChild(topRow);

  // Path row
  const domainRow = document.createElement('div');
  domainRow.className = 'token-domain-row';
  domainRow.innerHTML = `Path: <span class="domain-hl">${escapeHtml(c.path || '/')}</span>`;
  card.appendChild(domainRow);

  // Attributes flags with icons
  const attrRow = document.createElement('div');
  attrRow.className = 'token-attributes';

  if (c.secure) {
    attrRow.innerHTML += `<span class="attr-tag attr-secure">${ICON_LOCK} Secure</span>`;
  }
  if (c.httpOnly) {
    attrRow.innerHTML += `<span class="attr-tag attr-http">${ICON_CODE} HttpOnly</span>`;
  }
  if (c.sameSite) {
    attrRow.innerHTML += `<span class="attr-tag">SameSite: ${escapeHtml(c.sameSite)}</span>`;
  }
  if (c.expirationDate) {
    const expDate = new Date(c.expirationDate * 1000).toLocaleDateString();
    attrRow.innerHTML += `<span class="attr-tag">Expires ${expDate}</span>`;
  } else {
    attrRow.innerHTML += `<span class="attr-tag">Session</span>`;
  }

  card.appendChild(attrRow);

  // Value box with Show/Hide and Copy
  const valBox = document.createElement('div');
  valBox.className = 'token-value-box';

  const valText = document.createElement('span');
  valText.className = 'token-value-text';
  const rawVal = String(c.value || '');

  let masked = true;
  const maskString = (s) => (s.length > 20 ? s.slice(0, 6) + '••••••••••' + s.slice(-4) : '••••••••');
  valText.textContent = maskString(rawVal);

  const eyeBtn = document.createElement('button');
  eyeBtn.className = 'action-btn';
  eyeBtn.textContent = 'Show';
  eyeBtn.onclick = () => {
    masked = !masked;
    valText.textContent = masked ? maskString(rawVal) : rawVal;
    eyeBtn.textContent = masked ? 'Show' : 'Hide';
  };

  const copyValBtn = document.createElement('button');
  copyValBtn.className = 'action-btn';
  copyValBtn.textContent = 'Copy';
  copyValBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(rawVal);
      copyValBtn.textContent = 'Copied!';
      setTimeout(() => (copyValBtn.textContent = 'Copy'), 1200);
      status(`Copied cookie value for "${c.name}"`, 'ok');
    } catch {
      status('Failed to copy', 'err');
    }
  };

  const deleteCookieBtn = document.createElement('button');
  deleteCookieBtn.className = 'action-btn token-delete-btn';
  deleteCookieBtn.title = `Delete cookie "${c.name}" from browser`;
  deleteCookieBtn.innerHTML = `🗑️`;
  deleteCookieBtn.onclick = () => {
    showDeleteConfirmationModal({
      title: `Delete Cookie "${c.name}"?`,
      domain: c.domain,
      isSingleCookie: true,
      cookieName: c.name,
      onConfirm: async () => {
        status(`Deleting cookie "${c.name}"…`);
        try {
          await send({
            type: 'DELETE_SINGLE_COOKIE',
            cookie: c,
          });
          await loadAllBrowserCookies();
          status(`✓ Deleted cookie "${c.name}" from browser store.`, 'ok');
        } catch (err) {
          status(`Failed to delete cookie: ${err?.message || err}`, 'err');
        }
      },
    });
  };

  valBox.append(valText, eyeBtn, copyValBtn, deleteCookieBtn);
  card.appendChild(valBox);

  // JWT Decoder (if token is a valid JWT)
  if (isJwtVal) {
    const jwtBox = document.createElement('div');
    jwtBox.className = 'jwt-box';

    const header = parseJwtHeader(rawVal);
    const payload = parseJwt(rawVal);

    let summaryText = 'Valid JWT';
    if (payload?.sub) summaryText += ` • sub: ${escapeHtml(payload.sub)}`;
    if (payload?.exp) {
      const expDate = new Date(payload.exp * 1000).toLocaleString();
      summaryText += ` • exp: ${expDate}`;
    }

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'jwt-toggle-btn';
    toggleBtn.innerHTML = `
      <span>${ICON_CODE} ${summaryText}</span>
      <span class="jwt-badge-raw">Inspect</span>
    `;

    const detailsPre = document.createElement('pre');
    detailsPre.className = 'jwt-decoded-view hidden';
    detailsPre.textContent = JSON.stringify({ header, payload }, null, 2);

    toggleBtn.onclick = () => {
      const isHidden = detailsPre.classList.contains('hidden');
      detailsPre.classList.toggle('hidden', !isHidden);
      toggleBtn.querySelector('.jwt-badge-raw').textContent = isHidden ? 'Close' : 'Inspect';
    };

    jwtBox.append(toggleBtn, detailsPre);
    card.appendChild(jwtBox);
  }

  return card;
}

/**
 * Check if local cookies and remote cookies for a domain differ.
 */
function areSessionsDifferent(localCookies, remoteCookies) {
  if (!remoteCookies || !Array.isArray(remoteCookies) || remoteCookies.length === 0) {
    return false;
  }
  if (localCookies.length !== remoteCookies.length) return true;

  const localMap = new Map();
  for (const c of localCookies) {
    localMap.set(`${c.name}|${c.path || '/'}`, c.value);
  }

  for (const rc of remoteCookies) {
    const key = `${rc.name}|${rc.path || '/'}`;
    if (!localMap.has(key)) return true;
    if (localMap.get(key) !== rc.value) return true;
  }

  return false;
}

/**
 * Swap domain token/session:
 * Enforces persistent store tracking and blocks 3rd device swapping.
 */
async function handleSwapDomainSession(domain, currentCookies, remoteSession) {
  const root = getRootDomain(domain);
  if (activeSwaps[domain] || activeSwaps[root]) {
    status(`This domain is already swapped. You must Rollback before swapping again.`, 'err');
    return;
  }

  status(`Swapping session for ${domain}…`);

  try {
    const res = await send({
      type: 'SWAP_ACTIVE_TAB_SESSION',
      host: domain,
      currentCookies,
      remoteCookies: remoteSession.cookies,
      deviceName: remoteSession.deviceName,
      targetDeviceId: remoteSession.deviceId,
      baseVersion: remoteSession.version || 0,
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || 'Swap failed');
    }

    await loadAllBrowserCookies();
    await loadDevicesAndRemoteSessions();

    const deviceOrigin = remoteSession.deviceName ? ` from ${remoteSession.deviceName}` : '';
    status(`✓ Swapped tokens for ${domain}${deviceOrigin}! Swap record created.`, 'ok');
    checkActiveTabAndRenderBanner();
  } catch (e) {
    status(`Swap failed: ${e?.message || e}`, 'err');
  }
}

/**
 * Rollback domain swap:
 * Restores exact original tokens into cookies and removes persistent record.
 */
async function handleRollbackDomainSession(domain) {
  status(`Restoring original tokens for ${domain}…`);
  try {
    const res = await send({
      type: 'RESTORE_SWAP_BACKUP',
      host: domain,
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || 'Rollback failed');
    }

    await loadAllBrowserCookies();
    await loadDevicesAndRemoteSessions();

    status(`✓ Rolled back ${domain}! Exact original cookies restored & record removed.`, 'ok');
    checkActiveTabAndRenderBanner();
  } catch (err) {
    status(`Rollback failed: ${err?.message || err}`, 'err');
  }
}

/**
 * Directly apply a remote session's cookies into the active browser.
 */
async function handleApplyRemoteSession(domain, remoteCookies, deviceName) {
  status(`Applying ${domain} session to this browser…`);
  try {
    await send({ type: 'APPLY_COOKIES', cookies: remoteCookies });
    await loadAllBrowserCookies();
    status(`✓ Applied ${domain} tokens from ${deviceName || 'cloud'} into this browser!`, 'ok');
  } catch (e) {
    status(`Failed to apply cookies: ${e?.message || e}`, 'err');
  }
}

function renderCookieFeed() {
  const listEl = $('cookies-list');
  const emptyEl = $('cookies-empty');
  listEl.innerHTML = '';

  const q = searchQuery.toLowerCase().trim();
  const activeCookies = getActiveCookiesForDisplay();

  // Filter cookies
  const filtered = activeCookies.filter((c) => {
    if (isLocalhost(c.domain)) return false;

    const d = cleanDomain(c.domain);
    if (selectedDomain && d !== selectedDomain) return false;

    const isAuth = isAuthToken(c.name, c.value);
    if (currentFilter === 'auth' && !isAuth) return false;
    if (currentFilter === 'secure' && !c.secure) return false;
    if (currentFilter === 'session' && !c.session && c.expirationDate) return false;

    if (q) {
      const matchName = String(c.name || '').toLowerCase().includes(q);
      const matchDomain = String(c.domain || '').toLowerCase().includes(q);
      const matchVal = String(c.value || '').toLowerCase().includes(q);
      if (!matchName && !matchDomain && !matchVal) return false;
    }

    return true;
  });

  if (filtered.length === 0) {
    emptyEl.classList.remove('hidden');
    const emptyTitleEl = emptyEl.querySelector('.empty-title');
    const emptyHintEl = emptyEl.querySelector('.empty-hint');
    if (selectedDeviceFilter !== 'current' && selectedDeviceFilter !== 'all') {
      const targetDevice = userDevices.find((d) => d.deviceId === selectedDeviceFilter);
      const devName = targetDevice?.name || 'This device';
      if (emptyTitleEl) emptyTitleEl.textContent = `No sessions synced from ${devName}`;
      if (emptyHintEl) {
        emptyHintEl.innerHTML = `${escapeHtml(devName)} has not uploaded any sessions yet.<br>Open Switch on ${escapeHtml(devName)} and click <strong>Sync All</strong> in the toolbar to upload sessions.`;
      }
    } else {
      if (emptyTitleEl) emptyTitleEl.textContent = 'No cookies found';
      if (emptyHintEl) emptyHintEl.textContent = 'No cookies match the current filter or search criteria.';
    }
    return;
  }
  emptyEl.classList.add('hidden');

  // Group filtered cookies by domain
  const groups = new Map();
  for (const c of filtered) {
    const domain = cleanDomain(c.domain);
    if (!groups.has(domain)) {
      groups.set(domain, []);
    }
    groups.get(domain).push(c);
  }

  // Sort domains by cookie count descending
  const sortedGroupEntries = Array.from(groups.entries()).sort((a, b) => {
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  const DOMAIN_PAGE_LIMIT = 10;
  const isFiltering = !!(q || selectedDomain);
  const shouldLimit = !isFiltering && !showAllDomains && sortedGroupEntries.length > DOMAIN_PAGE_LIMIT;
  const displayedGroupEntries = shouldLimit
    ? sortedGroupEntries.slice(0, DOMAIN_PAGE_LIMIT)
    : sortedGroupEntries;

  // Render domain accordions
  for (const [domain, cookiesInDomain] of displayedGroupEntries) {
    const authCountInDomain = cookiesInDomain.filter((c) => isAuthToken(c.name, c.value)).length;
    const isOpen = openDomainGroups.has(domain);

    const groupLi = document.createElement('li');
    groupLi.className = `domain-group ${isOpen ? 'is-open' : ''}`;
    groupLi.dataset.domain = domain;

    // Accordion Header
    const groupHeader = document.createElement('div');
    groupHeader.className = 'domain-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'domain-header-left';

    // Domain Favicon
    const faviconWrap = document.createElement('div');
    faviconWrap.className = 'domain-favicon-wrap';

    const faviconImg = document.createElement('img');
    faviconImg.className = 'domain-favicon';
    faviconImg.alt = '';
    faviconImg.src = getFaviconUrl(domain);
    faviconImg.onerror = () => faviconImg.classList.add('favicon-fallback');

    const fallbackIcon = document.createElement('span');
    fallbackIcon.className = 'domain-fallback-icon';
    fallbackIcon.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

    faviconWrap.append(faviconImg, fallbackIcon);
    headerLeft.appendChild(faviconWrap);

    // Domain Title
    const titleSpan = document.createElement('span');
    titleSpan.className = 'domain-title';
    titleSpan.textContent = domain;
    headerLeft.appendChild(titleSpan);

    // Cookie Count Badge
    const countBadge = document.createElement('span');
    countBadge.className = 'domain-count-badge';
    countBadge.textContent = `${cookiesInDomain.length}`;
    headerLeft.appendChild(countBadge);

    // Auth Tokens Badge if any
    if (authCountInDomain > 0) {
      const authBadge = document.createElement('span');
      authBadge.className = 'domain-auth-badge';
      authBadge.textContent = `${authCountInDomain} auth`;
      headerLeft.appendChild(authBadge);
    }

    // Check active swap record for this domain
    const rootDomain = getRootDomain(domain);
    const activeSwap = activeSwaps[domain] || activeSwaps[rootDomain];

    if (activeSwap) {
      groupLi.classList.add('is-swapped-domain');
      const swappedPill = document.createElement('span');
      swappedPill.className = 'domain-swapped-pill';
      const targetDev = activeSwap.target?.deviceName || activeSwap.swappedWithDevice || 'Remote';
      swappedPill.textContent = `⚡ Swapped`;
      swappedPill.title = `Currently swapped with ${targetDev}. Original tokens backed up.`;
      headerLeft.appendChild(swappedPill);
    }

    // Header Right
    const headerRight = document.createElement('div');
    headerRight.className = 'domain-header-right';

    // Check remote sessions for this domain
    const remoteSession = remoteSessions.find(
      (s) => cleanDomain(s.host) === domain && Array.isArray(s.cookies) && s.cookies.length > 0
    );

    if (remoteSession) {
      groupLi.classList.add('has-remote-session');
    }

    const localCookiesForDomain = allCookies.filter((c) => cleanDomain(c.domain) === domain);

    // 1. If viewing Current Browser:
    if (selectedDeviceFilter === 'current') {
      if (activeSwap) {
        // STRICT SWAP GUARD: Domain is already swapped! Do NOT show swap to 3rd device.
        // ONLY allow Rollback!
        const rollbackBtn = document.createElement('button');
        rollbackBtn.className = 'domain-rollback-btn';
        rollbackBtn.title = `Rollback: Restore exact original tokens and clear swap record for ${domain}`;
        rollbackBtn.innerHTML = `
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
            <path d="M3 3v5h5"/>
          </svg>
          <span>Rollback</span>
        `;
        rollbackBtn.onclick = async (e) => {
          e.stopPropagation();
          await handleRollbackDomainSession(domain);
        };
        headerRight.appendChild(rollbackBtn);
      } else if (remoteSession) {
        const isDiff = areSessionsDifferent(cookiesInDomain, remoteSession.cookies);
        if (isDiff) {
          const swapBtn = document.createElement('button');
          swapBtn.className = 'domain-swap-btn';
          swapBtn.title = `Swap with token from ${remoteSession.deviceName || 'cloud'}. Current token will be saved to cloud.`;
          swapBtn.innerHTML = `
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 3l4 4-4 4"/>
              <path d="M20 7H4"/>
              <path d="M8 21l-4-4 4-4"/>
              <path d="M4 17h16"/>
            </svg>
            <span>Swap</span>
          `;
          swapBtn.onclick = async (e) => {
            e.stopPropagation();
            await handleSwapDomainSession(domain, cookiesInDomain, remoteSession);
          };
          headerRight.appendChild(swapBtn);
        }
      } else {
        // Domain not yet in cloud: offer "Sync" so user can back it up or prepare for cross-browser swap
        const syncBtn = document.createElement('button');
        syncBtn.className = 'domain-sync-btn';
        syncBtn.title = `Sync ${domain} session to cloud vault so other devices can adopt or swap it`;
        syncBtn.innerHTML = `
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.3"/>
          </svg>
          <span>Sync</span>
        `;
        syncBtn.onclick = async (e) => {
          e.stopPropagation();
          syncBtn.disabled = true;
          await ensureHostAccess(domain);
          syncBtn.innerHTML = `<span>Syncing…</span>`;
          status(`Syncing ${domain} tokens to cloud vault…`);
          try {
            const res = await send({
              type: 'SYNC_PUSH_DOMAIN',
              host: domain,
              cookies: cookiesInDomain,
            });
            if (res?.results?.[0]?.status === 'conflict') {
              status(
                `Cloud has a newer copy of ${domain}. Pull it before overwriting.`,
                'err',
                3200,
              );
              syncBtn.disabled = false;
              syncBtn.innerHTML = `<span>Sync</span>`;
              return;
            }
            await loadDevicesAndRemoteSessions();
            status(`✓ Synced ${domain} (${cookiesInDomain.length} tokens) to cloud vault!`, 'ok');
            renderCookieFeed();
            checkActiveTabAndRenderBanner();
          } catch (err) {
            syncBtn.disabled = false;
            syncBtn.innerHTML = `<span>Sync</span>`;
            status(`Failed to sync ${domain}: ${err?.message || err}`, 'err');
          }
        };
        headerRight.appendChild(syncBtn);
      }
    } else if (selectedDeviceFilter !== 'current') {
      // 2. If viewing a remote device or all devices: provide "Apply to this Browser" button
      const applyBtn = document.createElement('button');
      applyBtn.className = 'domain-swap-btn';
      applyBtn.title = `Apply ${domain} session from ${cookiesInDomain[0]?._deviceOrigin || 'cloud'} to this active browser`;
      applyBtn.innerHTML = `
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>Adopt</span>
      `;
      applyBtn.onclick = async (e) => {
        e.stopPropagation();
        await handleApplyRemoteSession(domain, cookiesInDomain, cookiesInDomain[0]?._deviceOrigin);
      };
      headerRight.appendChild(applyBtn);
    }

    // 3. Delete Domain Session Button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'domain-delete-btn';
    deleteBtn.title = `Delete all tokens for ${domain} from browser cookies, cloud server, and local storage`;
    deleteBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 6h18"/>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      </svg>
      <span>Delete</span>
    `;
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      showDeleteConfirmationModal({
        title: `Delete Session for ${domain}?`,
        domain,
        cookieCount: cookiesInDomain.length,
        isSingleCookie: false,
        onConfirm: async ({ deleteServer } = {}) => {
          status(`Removing session and tokens for ${domain}…`);
          try {
            const res = await send({
              type: 'DELETE_DOMAIN_SESSION',
              host: domain,
              deleteServer: !!deleteServer,
            });

            await loadAllBrowserCookies();
            await loadDevicesAndRemoteSessions();

            const serverMsg = res?.serverDeleted
              ? ' • Cloud vault erased'
              : ' • Cloud vault preserved for auto-sign in';
            status(
              `✓ Removed ${res?.cookiesRemovedCount || 0} cookies for ${domain}${serverMsg}!`,
              'ok'
            );
          } catch (err) {
            status(`Failed to delete ${domain}: ${err?.message || err}`, 'err');
          }
        },
      });
    };
    headerRight.appendChild(deleteBtn);

    // Chevron Icon
    const chevronSpan = document.createElement('span');
    chevronSpan.innerHTML = `
      <svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6 6-6"/>
      </svg>
    `;
    headerRight.appendChild(chevronSpan);

    groupHeader.append(headerLeft, headerRight);
    groupLi.appendChild(groupHeader);

    // Cookies List in Domain
    const cookiesUl = document.createElement('ul');
    cookiesUl.className = `domain-cookies-list ${isOpen ? '' : 'hidden'}`;

    // If domain is swapped, render swap tracking box showing origin vs target
    if (activeSwap) {
      const trackBox = document.createElement('div');
      trackBox.className = 'domain-swap-track-box';
      const origDev = activeSwap.origin?.deviceName || 'This Browser (Original)';
      const targetDev = activeSwap.target?.deviceName || activeSwap.swappedWithDevice || 'Remote Session';
      const origCount = activeSwap.origin?.cookieCount || activeSwap.origin?.cookies?.length || '–';
      const targetCount = activeSwap.target?.cookieCount || activeSwap.target?.cookies?.length || cookiesInDomain.length;
      trackBox.innerHTML = `
        <div class="swap-track-header">
          <span class="swap-track-badge">Active swap</span>
          <span class="swap-track-time">Swapped ${formatRelativeTime(activeSwap.swappedAt)}</span>
        </div>
        <div class="swap-track-grid">
          <div class="swap-track-col">
            <span class="swap-track-label">Saved original</span>
            <span class="swap-track-val" title="${escapeHtml(origDev)}">${escapeHtml(origDev)}</span>
            <span class="swap-track-sub">${origCount} original cookies saved</span>
          </div>
          <div class="swap-track-arrow">⇄</div>
          <div class="swap-track-col">
            <span class="swap-track-label">Active tokens</span>
            <span class="swap-track-val" title="${escapeHtml(targetDev)}">${escapeHtml(targetDev)}</span>
            <span class="swap-track-sub">${targetCount} active tokens running</span>
          </div>
        </div>
        <div class="swap-track-notice">
          <span>To swap to a different device, rollback to the original session first.</span>
        </div>
      `;
      cookiesUl.appendChild(trackBox);
    }

    // Sort cookies inside domain: Auth tokens first, then alphabetical
    cookiesInDomain.sort((a, b) => {
      const aAuth = isAuthToken(a.name, a.value);
      const bAuth = isAuthToken(b.name, b.value);
      if (aAuth && !bAuth) return -1;
      if (!aAuth && bAuth) return 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    for (const c of cookiesInDomain) {
      cookiesUl.appendChild(createCookieCard(c));
    }

    groupLi.appendChild(cookiesUl);

    // Toggle Accordion Click
    groupHeader.onclick = () => {
      const currentlyOpen = groupLi.classList.contains('is-open');
      if (currentlyOpen) {
        groupLi.classList.remove('is-open');
        cookiesUl.classList.add('hidden');
        openDomainGroups.delete(domain);
      } else {
        groupLi.classList.add('is-open');
        cookiesUl.classList.remove('hidden');
        openDomainGroups.add(domain);
      }
    };

    listEl.appendChild(groupLi);
  }

  // Show More / Show Less button when exceeding 10 domains
  if (!isFiltering && sortedGroupEntries.length > DOMAIN_PAGE_LIMIT) {
    const moreLi = document.createElement('li');
    moreLi.className = 'domain-more-wrap';
    if (!showAllDomains) {
      const remainingCount = sortedGroupEntries.length - DOMAIN_PAGE_LIMIT;
      moreLi.innerHTML = `
        <button id="show-more-domains-btn" class="btn-show-more-domains" title="Show all ${sortedGroupEntries.length} domains">
          <span>+ ${remainingCount} more domain${remainingCount === 1 ? '' : 's'}…</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      `;
      moreLi.querySelector('button').onclick = () => {
        showAllDomains = true;
        renderCookieFeed();
      };
    } else {
      moreLi.innerHTML = `
        <button id="show-less-domains-btn" class="btn-show-more-domains" title="Collapse to top 10 domains">
          <span>Show top 10 domains only ▲</span>
        </button>
      `;
      moreLi.querySelector('button').onclick = () => {
        showAllDomains = false;
        renderCookieFeed();
      };
    }
    listEl.appendChild(moreLi);
  }
}

// ---------------- CONTROLS & LISTENERS ----------------

// Tab Switching
$('tab-btn-cookies').onclick = () => switchAppTab('cookies');
$('tab-btn-devices').onclick = () => switchAppTab('devices');
$('tab-btn-account').onclick = () => switchAppTab('account');

// Device Selector on Cookies Tab
$('cookie-device-select').onchange = (e) => {
  selectedDeviceFilter = e.target.value;
  selectedDomain = '';
  populateDomainFilter();
  updateMetrics();
  renderCookieFeed();
};

// Domain Selector
$('cookie-domain-select').onchange = (e) => {
  selectedDomain = e.target.value;
  if (selectedDomain) {
    openDomainGroups.add(selectedDomain);
  }
  renderCookieFeed();
};

// Vault Key Encryption Sync Handler
const vaultSyncForm = $('vault-sync-form');
if (vaultSyncForm) {
  vaultSyncForm.onsubmit = async (e) => {
    e.preventDefault();
    const pwInput = $('vault-sync-password');
    const msgEl = $('vault-sync-msg');
    const submitBtn = $('vault-sync-submit-btn');
    const password = pwInput?.value;
    if (!password || !currentUser?.email) return;

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Syncing…';
    }
    if (msgEl) {
      msgEl.className = 'vault-sync-msg';
      msgEl.classList.remove('hidden');
      msgEl.textContent = 'Deriving encryption key & verifying credentials…';
    }

    try {
      const serverUrl = await getServerUrl();
      await login(currentUser.email, password, serverUrl);

      if (msgEl) {
        msgEl.className = 'vault-sync-msg ok';
        msgEl.textContent = '✓ Vault unlocked. Syncing saved sites only…';
      }

      await send({ type: 'SYNC_PUSH_ALL', explicit: true });
      await loadAllBrowserCookies();
      await loadDevicesAndRemoteSessions();
      await checkActiveTabAndRenderBanner();

      status('✓ Vault encryption key successfully synced with Edge!', 'ok');
      setTimeout(() => {
        $('vault-key-sync-banner')?.classList.add('hidden');
      }, 1200);
    } catch (err) {
      if (msgEl) {
        msgEl.className = 'vault-sync-msg err';
        msgEl.textContent = `Sync failed: ${err?.message || err}`;
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock & Sync';
      }
    }
  };
}

// Sync All Local Domains to Encrypted Cloud Vault
const syncAllBtn = $('cookie-sync-all-btn');
if (syncAllBtn) {
  syncAllBtn.onclick = async () => {
    syncAllBtn.disabled = true;
    status('Syncing sites you have saved…');
    try {
      const res = await send({ type: 'SYNC_PUSH_ALL', explicit: true });
      await loadDevicesAndRemoteSessions();
      status(`✓ Synced ${res?.syncedDomainsCount || 0} saved site(s) to your encrypted vault.`, 'ok');
    } catch (e) {
      status(`Sync failed: ${e?.message || e}`, 'err');
    } finally {
      syncAllBtn.disabled = false;
    }
  };
}

// DevTools Inspect & Suction Sync Button
const inspectSyncBtn = $('cookie-inspect-sync-btn');
if (inspectSyncBtn) {
  inspectSyncBtn.onclick = async () => {
    status('Launching DevTools Cookie Inspector on active tab…');
    const tabs = await CH.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    let domain = '';
    let cookies = [];
    if (tab?.url && tab.url.startsWith('http')) {
      try {
        domain = new URL(tab.url).hostname;
        cookies = allCookies.filter((c) => hostMatches(c.domain, domain));
      } catch { }
    }
    await triggerInspectSyncAnimation(domain, cookies.length ? cookies : allCookies.slice(0, 20));
    status('✓ DevTools Cookie Inspector streaming tokens on active tab!', 'ok');
  };
}

// Refresh Cookies
$('cookie-refresh-btn').onclick = async () => {
  await loadAllBrowserCookies();
  await loadDevicesAndRemoteSessions();
};

// Refresh Devices
$('devices-refresh-btn').onclick = async () => {
  status('Refreshing devices and sessions…');
  await loadDevicesAndRemoteSessions();
  status('Devices & sessions updated.', 'ok');
};


// Toggle All Domain Groups (Expand / Collapse All)
$('cookie-toggle-groups-btn').onclick = () => {
  areAllGroupsOpen = !areAllGroupsOpen;
  openDomainGroups.clear();

  if (areAllGroupsOpen) {
    const activeCookies = getActiveCookiesForDisplay();
    for (const c of activeCookies) {
      if (!isLocalhost(c.domain)) {
        openDomainGroups.add(cleanDomain(c.domain));
      }
    }
  }

  document.querySelectorAll('.domain-group').forEach((groupEl) => {
    groupEl.classList.toggle('is-open', areAllGroupsOpen);
    const subList = groupEl.querySelector('.domain-cookies-list');
    if (subList) subList.classList.toggle('hidden', !areAllGroupsOpen);
  });
};

// Search Input & Clear
const searchInput = $('cookie-search');
const searchClearBtn = $('cookie-search-clear');

if (searchInput) {
  searchInput.oninput = (e) => {
    searchQuery = e.target.value;
    if (searchClearBtn) {
      searchClearBtn.classList.toggle('hidden', !searchQuery);
    }
    renderCookieFeed();
  };
}

if (searchClearBtn) {
  searchClearBtn.onclick = () => {
    searchQuery = '';
    if (searchInput) {
      searchInput.value = '';
      searchInput.focus();
    }
    searchClearBtn.classList.add('hidden');
    renderCookieFeed();
  };
}

// Filter Pills
document.querySelectorAll('.filter-pill').forEach((pill) => {
  pill.onclick = () => {
    document.querySelectorAll('.filter-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    currentFilter = pill.dataset.filter;
    renderCookieFeed();
  };
});

// Copy Filtered Cookies as JSON (Icon-safe feedback)
$('cookie-copy-all-btn').onclick = async () => {
  const activeCookies = getActiveCookiesForDisplay();
  if (activeCookies.length === 0) return status('No cookies available to copy.', 'err');

  const q = searchQuery.toLowerCase().trim();
  const exportItems = activeCookies.filter((c) => {
    if (isLocalhost(c.domain)) return false;

    const d = cleanDomain(c.domain);
    if (selectedDomain && d !== selectedDomain) return false;
    const isAuth = isAuthToken(c.name, c.value);
    if (currentFilter === 'auth' && !isAuth) return false;
    if (currentFilter === 'secure' && !c.secure) return false;
    if (currentFilter === 'session' && !c.session && c.expirationDate) return false;
    if (q) {
      const matchName = String(c.name || '').toLowerCase().includes(q);
      const matchDomain = String(c.domain || '').toLowerCase().includes(q);
      const matchVal = String(c.value || '').toLowerCase().includes(q);
      if (!matchName && !matchDomain && !matchVal) return false;
    }
    return true;
  });

  try {
    await navigator.clipboard.writeText(JSON.stringify(exportItems, null, 2));
    const btn = $('cookie-copy-all-btn');
    const originalHtml = btn.innerHTML;
    btn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    `;
    btn.title = 'Copied to clipboard!';
    btn.classList.add('btn-copied-ok');
    setTimeout(() => {
      btn.innerHTML = originalHtml;
      btn.title = 'Copy visible cookies as JSON';
      btn.classList.remove('btn-copied-ok');
    }, 1500);
    status(`Copied ${exportItems.length} cookies to clipboard as JSON.`, 'ok');
  } catch {
    status('Failed to copy to clipboard', 'err');
  }
};

// Account Logout Confirmation
$('account-logout-btn').onclick = () => {
  showLogoutConfirmationModal();
};

$('logout-modal-confirm')?.addEventListener('click', async () => {
  hideLogoutConfirmationModal();
  status('Signing out…');
  try {
    await send({ type: 'AUTH_LOGOUT' });
  } catch (err) {
    console.warn('[switch] logout request failed:', err?.message || err);
  }
  currentUser = null;
  allCookies = [];
  remoteSessions = [];
  userDevices = [];
  allDevices = [];
  status('Signed out of this browser. Synced sessions were kept.', 'ok', 2600);
  showScreen('login');
});

// Lock Vault Key
const lockBtn = $('account-lock-btn');
if (lockBtn) {
  lockBtn.onclick = async () => {
    // The key lives in chrome.storage.session now. Remove both the session
    // copy and the legacy persistent marker.
    await CH.storage.session.remove('vaultKeyRaw');
    await CH.storage.local.remove(['vaultKeyRaw', 'vaultKeyDerived']);
    status('Vault key locked from memory.', 'ok');
    await checkVaultKeySyncStatus();
    await updateAccountTab();
  };
}

// Privacy notice
$('account-privacy-btn')?.addEventListener('click', () => {
  CH.tabs.create({ url: CH.runtime.getURL('src/onboarding/privacy.html') });
});

// ---------------- SYNC SETTINGS ----------------

async function initSettingsForm() {
  const form = $('settings-form');
  if (!form) return;

  const res = await send({ type: 'SETTINGS_GET' }).catch(() => null);
  if (!res) return;

  if ($('settings-server-url')) $('settings-server-url').value = res.serverUrl || '';
  if ($('settings-auto-sync')) $('settings-auto-sync').checked = !!res.autoSync;

  if (!form.dataset.bound) {
    form.dataset.bound = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('settings-msg');
      const serverValue = String($('settings-server-url')?.value || '').trim();
      if (!serverValue) {
        if (msg) {
          msg.textContent = 'Sync server URL cannot be empty.';
          msg.className = 'settings-msg err';
          msg.classList.remove('hidden');
        }
        return;
      }

      const saveBtn = $('settings-save-btn');
      if (saveBtn) saveBtn.disabled = true;
      try {
        const updated = await send({
          type: 'AUTH_SET_SERVER',
          serverUrl: serverValue,
        });
        await send({
          type: 'SETTINGS_SET',
          autoSync: !!$('settings-auto-sync')?.checked,
        });
        if (msg) {
          msg.textContent = `Saved. Server: ${updated.serverUrl}`;
          msg.className = 'settings-msg ok';
          msg.classList.remove('hidden');
        }
        await updateAccountTab();
      } catch (err) {
        if (msg) {
          msg.textContent = `Could not save settings: ${err?.message || err}`;
          msg.className = 'settings-msg err';
          msg.classList.remove('hidden');
        }
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    });
  }
}

// ---------------- ACCOUNT EXPORT / DELETE ----------------

function hideDeleteAccountModal() {
  $('delete-account-modal')?.classList.add('hidden');
}
function showDeleteAccountModal() {
  $('delete-account-modal')?.classList.remove('hidden');
}

$('delete-account-close')?.addEventListener('click', hideDeleteAccountModal);
$('delete-account-cancel')?.addEventListener('click', hideDeleteAccountModal);
$('delete-account-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'delete-account-modal') hideDeleteAccountModal();
});

$('account-export-btn')?.addEventListener('click', async () => {
  const btn = $('account-export-btn');
  if (btn) btn.disabled = true;
  try {
    const res = await send({ type: 'ACCOUNT_EXPORT' });
    const blob = new Blob([JSON.stringify(res.data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `switch-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    status('Export downloaded. Envelopes are encrypted with your master password.', 'ok', 3200);
  } catch (err) {
    status(`Export failed: ${err?.message || err}`, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('account-delete-btn')?.addEventListener('click', showDeleteAccountModal);

$('delete-account-confirm')?.addEventListener('click', async () => {
  hideDeleteAccountModal();
  status('Deleting account and all synced data…');
  try {
    await send({ type: 'ACCOUNT_DELETE', confirm: true });
    currentUser = null;
    allCookies = [];
    remoteSessions = [];
    userDevices = [];
    allDevices = [];
    status('Account deleted. Nothing remains on the server.', 'ok', 3200);
  } catch (err) {
    status(`Deletion failed: ${err?.message || err}`, 'err');
    return;
  }
  showScreen('login');
});

// ---------------- INITIALIZATION ----------------

async function init() {
  await initTheme();

  // Show the configured (or development default) server explicitly. Nothing is
  // silently assumed.
  try {
    const configured = await getServerUrl();
    if ($('auth-server-url')) $('auth-server-url').value = configured || '';
    if ($('auth-server-hint')) {
      $('auth-server-hint').textContent =
        configured && configured.startsWith('http://localhost')
          ? 'Development default: http://localhost:8080. Replace it with your production sync server before signing in.'
          : 'Only encrypted blobs are stored on this server.';
    }
  } catch (e) {
    console.warn('[switch] could not read server URL:', e?.message || e);
  }

  let workerOk = true;
  try {
    const ping = await send({ type: 'PING' });
    workerOk = !!ping?.ok && ping.protocol === PROTOCOL;
  } catch {
    workerOk = false;
  }
  if (!workerOk) {
    status('Extension worker reloaded. Reopen popup if needed.', 'err');
  }

  // Retrieve current device information
  await initCurrentDevice();

  // STEP 1: Check Auth Status First
  const authRes = await send({ type: 'AUTH_STATUS' }).catch(() => null);

  if (!authRes?.loggedIn || !authRes.user) {
    currentUser = null;
    showScreen('login');
    return;
  }

  currentUser = authRes.user;

  // STEP 2: Consent Form Check
  await checkConsentAndProceed();
}

init().catch((e) => {
  console.error('[switch] popup init failed', e);
  status(`Encountered error: ${e?.message || e}`, 'err');
});
