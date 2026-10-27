// Login-form detector.
//
// Registered as a SEPARATE content script from restore.js because the two need
// different run_at: restore must be document_start (before the app boots),
// this must be document_idle (after DOM is usable). One registration = one
// run_at, so we register two entries per granted origin.
//
// Runs ONLY on origins the user explicitly granted. That is the whole
// store-policy story — see docs/STORE_JUSTIFICATION.md.
//
// FLOW
//   1. Check policy/caps (storage) -> if blocked return
//   2. Detect login form + query background for swap/session info
//   3. Start intent observer (focus, click, mouse proximity, dwell)
//   4. Show immediately on focus OR when engagement score >= threshold
//   5. Apply cooldowns on dismiss/swap/restore

(() => {
  const HOST = location.hostname;
  const MSG_ID = 'switch-toast-root';
  const POLICY_KEY = 'switch_toast_policy_v1';

  const isSearchEngine = (host) => {
    if (!host) return false;
    const h = String(host).replace(/^\./, '').toLowerCase().trim();
    if (/^([a-z0-9-]+\.)?google\.[a-z.]+$/i.test(h)) return true;
    if (/^([a-z0-9-]+\.)?(bing|duckduckgo|baidu|yandex|ecosia|ask|search\.yahoo)\.[a-z.]+$/i.test(h)) return true;
    return false;
  };

  const isLocalhost = (host) => {
    if (!host) return false;
    const h = String(host).replace(/^\./, '').toLowerCase().trim();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  };

  // Never run or show prompts on Google Search, other search engines, or localhost
  if (isSearchEngine(HOST) || isLocalhost(HOST)) return;

  if (document.getElementById(MSG_ID)) return;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch {
        resolve(null); // extension was reloaded / invalidated
      }
    });

  // -------------------- POLICY (storage-based cooldowns/caps) --------------------
  const now = () => Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const HOUR_MS = 60 * 60 * 1000;

  async function loadPolicy() {
    try {
      const res = await chrome.storage.local.get(POLICY_KEY);
      const all = res?.[POLICY_KEY] || {};
      return all[HOST] || null;
    } catch {
      return null;
    }
  }

  async function savePolicy(patch) {
    try {
      const res = await chrome.storage.local.get(POLICY_KEY);
      const all = res?.[POLICY_KEY] || {};
      const current = all[HOST] || {};
      all[HOST] = { ...current, ...patch, updatedAt: now() };
      await chrome.storage.local.set({ [POLICY_KEY]: all });
    } catch {}
  }

  async function isBlockedByPolicy() {
    const p = await loadPolicy();
    if (!p) return false;

    // If user already used swap/restore recently, don't nag
    if (p.usedAt && now() - p.usedAt < 48 * HOUR_MS) {
      return true;
    }

    // Dismissal cooldown
    if (p.dismissedUntil && now() < p.dismissedUntil) {
      return true;
    }

    // Frequency cap: max 2 impressions in last 24h
    const lastShown = p.lastShownAt || 0;
    if (lastShown && now() - lastShown < DAY_MS) {
      const count = p.shownCount24h || 0;
      if (count >= 2) return true;
    }

    return false;
  }

  async function recordShown() {
    const p = await loadPolicy();
    const lastShown = p?.lastShownAt || 0;
    let count = p?.shownCount24h || 0;
    if (!lastShown || now() - lastShown >= DAY_MS) {
      count = 1;
    } else {
      count = (count || 0) + 1;
    }
    await savePolicy({ lastShownAt: now(), shownCount24h: count, lastAction: 'shown' });
  }

  async function recordDismiss() {
    const p = await loadPolicy();
    const lastDismiss = p?.lastDismissAt || 0;
    // First dismiss: +4h, if dismissed again within 24h -> +12h
    let hours = 4;
    if (lastDismiss && now() - lastDismiss < DAY_MS) {
      hours = 12;
    }
    await savePolicy({
      lastAction: 'dismiss',
      lastDismissAt: now(),
      dismissedUntil: now() + hours * HOUR_MS,
    });
  }

  async function recordUsed() {
    await savePolicy({
      lastAction: 'used',
      usedAt: now(),
    });
  }

  // -------------------- PAGE DETECTION --------------------
  const detectPageLoginState = () => {
    // 1. Password inputs
    const passwordInputs = Array.from(
      document.querySelectorAll('input[type="password"], input[autocomplete*="password"]')
    );
    const hasPassword = passwordInputs.length > 0;

    // 2. Email or username inputs
    const emailInputs = Array.from(
      document.querySelectorAll(
        'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete*="email" i], input[name*="user" i], input[id*="user" i], input[autocomplete*="username" i], input[name*="login" i], input[id*="login" i]'
      )
    );
    const hasEmailOrUsername = emailInputs.length > 0;

    // 3. Login or signup buttons / links
    const buttonsAndLinks = Array.from(
      document.querySelectorAll('button, input[type="submit"], a, [role="button"]')
    );
    const loginSignupKeywords = /^(?:log\s*in|sign\s*in|sign\s*up|register|create\s*(?:an?\s*)?account|get\s*started)$/i;
    const partialLoginRegex = /log\s*in|sign\s*in|sign\s*up|create\s*account/i;

    const hasLoginOrSignupButton = buttonsAndLinks.some((el) => {
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      return text.length < 35 && (loginSignupKeywords.test(text) || partialLoginRegex.test(text));
    });

    // 4. Typical login or signin form tag
    const loginForm = document.querySelector(
      'form[action*="login" i], form[action*="signin" i], form[id*="login" i], form[id*="signin" i], form[class*="login" i], form[class*="signin" i]'
    );
    const hasLoginFormTag = !!(loginForm && loginForm.querySelector('input:not([type="hidden"])'));

    // 5. Logged-in session indicators
    const logoutKeywords = /log\s*out|sign\s*out|disconnect/i;
    const hasLogoutButton = buttonsAndLinks.some((el) => {
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
      return text.length < 35 && logoutKeywords.test(text);
    });

    const hasAvatar = !!document.querySelector(
      'img[alt*="avatar" i], img[class*="avatar" i], [aria-label*="account" i], [aria-label*="profile" i], [data-testid*="user-menu" i]'
    );

    const hasLoginForm =
      hasPassword ||
      hasLoginFormTag ||
      (hasEmailOrUsername && hasLoginOrSignupButton);

    const looksLoggedIn = hasLogoutButton || hasAvatar;

    return {
      hasLoginForm,
      hasPassword,
      hasEmailOrUsername,
      hasLoginOrSignupButton,
      hasLogoutButton,
      hasAvatar,
      looksLoggedIn,
      passwordInputs,
      emailInputs,
      loginForm,
    };
  };

  const findLoginTargets = (state) => {
    const targets = [];
    if (state?.passwordInputs?.length) {
      state.passwordInputs.forEach((el) => targets.push(el));
    }
    if (state?.emailInputs?.length) {
      state.emailInputs.slice(0, 3).forEach((el) => targets.push(el));
    }
    if (state?.loginForm) {
      targets.push(state.loginForm);
    }
    // Deduplicate
    const seen = new Set();
    return targets.filter((el) => {
      if (!el || seen.has(el)) return false;
      seen.add(el);
      return true;
    });
  };

  // Allow background & popup to query the live DOM login state or force show toast
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'DETECT_PAGE_STATE') {
      sendResponse(detectPageLoginState());
      return true;
    }
    if (msg?.type === 'SHOW_SWAP_TOAST' || msg?.type === 'REFRESH_TOAST') {
      evaluate(true);
      sendResponse({ ok: true });
      return true;
    }
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------- INTENT TRACKING --------------------
  const intent = {
    score: 0,
    nearFormMs: 0,
    lastSeenNear: 0,
    focusedField: false,
    clickedForm: false,
    sawSubmit: false,
    formTargets: [],
    shown: false,
    swapInfo: null,
    abort: null,
    moveThrottle: 0,
    intervalId: null,
    dwellStart: 0,
  };

  function distanceToRect(mx, my, rect) {
    if (!rect) return Infinity;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const distCenter = Math.sqrt(dx * dx + dy * dy);
    if (mx >= rect.left && mx <= rect.right && my >= rect.top && my <= rect.bottom) {
      return 40;
    }
    const distX = mx < rect.left ? rect.left - mx : mx > rect.right ? mx - rect.right : 0;
    const distY = my < rect.top ? rect.top - my : my > rect.bottom ? my - rect.bottom : 0;
    const edgeDist = Math.sqrt(distX * distX + distY * distY);
    return Math.min(distCenter, edgeDist === 0 ? 60 : edgeDist);
  }

  function computeProximity(mx, my) {
    if (!intent.formTargets.length) return Infinity;
    let minDist = Infinity;
    for (const el of intent.formTargets) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const d = distanceToRect(mx, my, rect);
        if (d < minDist) minDist = d;
      } catch {}
    }
    return minDist;
  }

  function updateScore() {
    let s = 0;
    if (intent.focusedField) s += 40;
    if (intent.clickedForm) s += 25;
    if (intent.sawSubmit) s += 15;
    if (intent.nearFormMs > 2000) s += 15;
    else if (intent.nearFormMs > 1000) s += 10;
    else if (intent.nearFormMs > 500) s += 6;

    if (!intent.focusedField && intent.lastSeenNear && now() - intent.lastSeenNear > 8000) {
      s -= 12;
    }
    if (!intent.focusedField && intent.lastSeenNear && now() - intent.lastSeenNear > 12000) {
      s -= 10;
    }

    intent.score = Math.max(0, Math.min(100, s));
    return intent.score;
  }

  function tryShow(reason = 'score') {
    if (intent.shown) return;
    if (!intent.swapInfo) return;
    isBlockedByPolicy().then((blocked) => {
      if (blocked || intent.shown) return;
      intent.shown = true;
      cleanupIntentObserver();
      recordShown();
      renderToastFromSwapInfo(intent.swapInfo);
    });
  }

  function cleanupIntentObserver() {
    if (intent.abort) {
      try {
        intent.abort.abort();
      } catch {}
      intent.abort = null;
    }
    if (intent.intervalId) {
      clearInterval(intent.intervalId);
      intent.intervalId = null;
    }
    intent.formTargets = [];
  }

  function startIntentObserver(swapInfo) {
    if (intent.shown) return;
    intent.swapInfo = swapInfo;
    intent.abort = new AbortController();
    const signal = intent.abort.signal;

    const state = detectPageLoginState();
    intent.formTargets = findLoginTargets(state);
    intent.dwellStart = now();
    intent.nearFormMs = 0;
    intent.lastSeenNear = 0;
    intent.focusedField = false;
    intent.clickedForm = false;
    intent.sawSubmit = false;
    intent.score = 0;
    intent.shown = false;

    const onMouseMoveTrack = (e) => {
      const tNow = now();
      if (tNow - intent.moveThrottle < 120) return;
      intent.moveThrottle = tNow;
      const mx = e.clientX;
      const my = e.clientY;
      window.__switchMouseX = mx;
      window.__switchMouseY = my;
      const dist = computeProximity(mx, my);
      if (dist < 200) {
        intent.lastSeenNear = tNow;
      } else if (dist < 280) {
        if (!intent.lastSeenNear || tNow - intent.lastSeenNear > 1500) {
          intent.lastSeenNear = tNow;
        }
      }
    };

    document.addEventListener('mousemove', onMouseMoveTrack, { capture: true, signal });

    document.addEventListener(
      'focusin',
      (e) => {
        const t = e.target;
        if (!t || !(t instanceof Element)) return;
        const tag = t.tagName;
        const type = (t.getAttribute('type') || '').toLowerCase();
        const autocomplete = (t.getAttribute('autocomplete') || '').toLowerCase();
        const isPwd = type === 'password' || autocomplete.includes('password');
        const isEmailLike =
          type === 'email' ||
          autocomplete.includes('email') ||
          autocomplete.includes('username') ||
          /email|user|login/i.test(t.name || '') ||
          /email|user|login/i.test(t.id || '');
        if (tag === 'INPUT' && (isPwd || isEmailLike)) {
          intent.focusedField = true;
          intent.clickedForm = true;
          intent.lastSeenNear = now();
          updateScore();
          tryShow('focus');
        }
      },
      { capture: true, signal }
    );

    document.addEventListener(
      'click',
      (e) => {
        const t = e.target;
        if (!t) return;
        for (const el of intent.formTargets) {
          try {
            if (el.contains(t)) {
              intent.clickedForm = true;
              intent.lastSeenNear = now();
              updateScore();
              break;
            }
          } catch {}
        }
        const btnText = (t.textContent || t.value || '').trim().toLowerCase();
        if (/log\s*in|sign\s*in|submit|continue/.test(btnText) && btnText.length < 20) {
          intent.sawSubmit = true;
          updateScore();
        }
      },
      { capture: true, signal }
    );

    intent.intervalId = setInterval(() => {
      if (intent.shown) {
        cleanupIntentObserver();
        return;
      }
      if (intent.lastSeenNear && now() - intent.lastSeenNear < 600) {
        intent.nearFormMs += 250;
      }
      const score = updateScore();
      const dwell = now() - (intent.dwellStart || now());

      if (intent.focusedField) {
        tryShow('focus');
        return;
      }
      if (score >= 65) {
        setTimeout(() => tryShow('score65'), 400);
        return;
      }
      if (score >= 55 && dwell > 12000 && intent.nearFormMs > 2000) {
        setTimeout(() => tryShow('score55'), 500);
        return;
      }
      if (dwell > 25000 && score < 40) {
        cleanupIntentObserver();
        return;
      }
    }, 250);
  }

  async function evaluate(force = false) {
    if (!force && (await isBlockedByPolicy())) {
      return;
    }

    await sleep(400);

    const pageState = detectPageLoginState();

    const swapInfo = await send({ type: 'GET_ACTIVE_TAB_SWAP_INFO', pageState });
    if (!swapInfo || !swapInfo.ok) return;

    const { isUserAlreadyLoggedIn, hasLocalAuth, otherDeviceSession, backupSession, isSwapped, swapRecord } = swapInfo;

    const hasSomethingToOffer = !!(
      (isSwapped || backupSession || swapRecord) ||
      (otherDeviceSession && Array.isArray(otherDeviceSession.cookies) && otherDeviceSession.cookies.length > 0)
    );

    if (!hasSomethingToOffer && !force) return;

    startIntentObserver({
      swapInfo,
      isUserAlreadyLoggedIn,
      hasLocalAuth,
      otherDeviceSession,
      backupSession,
      isSwapped,
      swapRecord,
      pageState,
    });
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function cleanDevName(raw) {
    if (!raw) return 'another browser';
    return String(raw)
      .replace(/\s+on\s+/i, ' · ')
      .replace(/\s*\([^)]*\)/g, '')
      .trim();
  }

  function renderToastFromSwapInfo(ctx) {
    const { isUserAlreadyLoggedIn, hasLocalAuth, otherDeviceSession, backupSession, isSwapped, swapRecord } = ctx;
    const HOST_NAME = location.hostname;

    const isSwappedActive = !!(isSwapped || backupSession || swapRecord);
    if (isSwappedActive) {
      const devName = cleanDevName(backupSession?.swappedWithDevice || swapRecord?.target?.deviceName || 'Remote Session');
      renderToast({
        kind: 'swapped',
        domain: HOST_NAME,
        devName,
        title: 'Swapped Session',
        body: `Running session from <strong>${devName}</strong>.`,
        mode: 'RESTORE',
      });
      return;
    }

    if (otherDeviceSession && Array.isArray(otherDeviceSession.cookies) && otherDeviceSession.cookies.length > 0) {
      const devName = cleanDevName(otherDeviceSession.deviceName);
      const isSwap = hasLocalAuth || isUserAlreadyLoggedIn;
      renderToast({
        kind: isSwap ? 'swap' : 'remote_session',
        domain: HOST_NAME,
        devName,
        title: isSwap ? 'Swap Session Available' : 'Remote Session Ready',
        body: isSwap
          ? `Active session available from <strong>${devName}</strong> (${otherDeviceSession.cookies.length} tokens).`
          : `Found active login on <strong>${devName}</strong>. Sign in with 1 click.`,
        mode: isSwap ? 'SWAP' : 'SWITCH',
        otherDeviceSession,
      });
      return;
    }
  }

  function renderToast({ kind, domain = HOST, devName = '', title, body, mode = 'RESTORE', otherDeviceSession }) {
    const existing = document.getElementById(MSG_ID);
    if (existing) existing.remove();

    const hostEl = document.createElement('div');
    hostEl.id = MSG_ID;
    hostEl.style.cssText = 'all:initial !important; position:fixed !important; bottom:22px !important; right:22px !important; z-index:2147483647 !important; pointer-events:auto !important;';
    (document.fullscreenElement || document.body || document.documentElement).appendChild(hostEl);

    const shadow = hostEl.attachShadow({ mode: 'closed' });

    const rimColor =
      kind === 'swapped'
        ? '#c084fc'
        : kind === 'swap'
          ? '#38bdf8'
          : '#34d399';

    const domainColor =
      kind === 'swapped'
        ? '#d8b4fe'
        : kind === 'swap'
          ? '#7dd3fc'
          : '#6ee7b7';

    const domainBadgeBg =
      kind === 'swapped'
        ? 'rgba(168, 85, 247, 0.14)'
        : kind === 'swap'
          ? 'rgba(14, 165, 233, 0.14)'
          : 'rgba(16, 185, 129, 0.14)';

    const domainBadgeBorder =
      kind === 'swapped'
        ? 'rgba(168, 85, 247, 0.32)'
        : kind === 'swap'
          ? 'rgba(14, 165, 233, 0.32)'
          : 'rgba(16, 185, 129, 0.32)';

    const browserSpriteUrl =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('src/assets/browsers-sprite.png') : '';

    const getBrowserSpritePosition = (name) => {
      const b = String(name || '').toLowerCase();
      if (b.includes('edge') || b.includes('edg')) return '50% 0%';
      if (b.includes('firefox')) return '100% 0%';
      if (b.includes('safari')) return '0% 50%';
      if (b.includes('brave')) return '50% 50%';
      if (b.includes('opera') || b.includes('opr')) return '100% 50%';
      if (b.includes('arc')) return '0% 100%';
      if (b.includes('vivaldi')) return '50% 100%';
      if (b.includes('tor')) return '100% 100%';
      return '0% 0%';
    };

    const targetBrowserName = devName || otherDeviceSession?.deviceName || '';
    const spritePos = getBrowserSpritePosition(targetBrowserName);

    const logoUrl = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('src/assets/icon-48.png') : '';

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .switch-toast-card {
          position: fixed; right: 22px; bottom: 22px; width: 360px; max-width: calc(100vw - 44px);
          border-radius: 14px;
          padding: 1.5px;
          background: rgba(255, 255, 255, 0.08);
          box-shadow: 0 20px 48px -6px rgba(0, 0, 0, 0.8), 0 0 24px rgba(168, 85, 247, 0.25);
          transform: translateY(16px) scale(0.98); opacity: 0;
          transition: transform .24s cubic-bezier(0.16, 1, 0.3, 1), opacity .2s ease;
          box-sizing: border-box;
          z-index: 2147483647;
          overflow: hidden;
        }
        .switch-toast-card * { box-sizing: border-box; }
        .switch-toast-card.in { transform: translateY(0) scale(1); opacity: 1; }
        .toast-border-beam-1,
        .toast-border-beam-2 {
          position: absolute;
          top: -60%;
          left: -60%;
          width: 220%;
          height: 220%;
          pointer-events: none;
          z-index: 0;
          will-change: transform;
        }
        .toast-border-beam-1 {
          background: conic-gradient(from 0deg, transparent 0%, transparent 72%, rgba(0, 242, 254, 0.08) 82%, #00f2fe 92%, #38bdf8 97%, transparent 100%);
          animation: toastBorderSpin1 3.5s linear infinite;
        }
        .toast-border-beam-2 {
          background: conic-gradient(from 180deg, transparent 0%, transparent 72%, rgba(168, 85, 247, 0.08) 82%, #a855f7 92%, #ec4899 97%, transparent 100%);
          animation: toastBorderSpin1 3.5s linear infinite;
        }
        @keyframes toastBorderSpin1 { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .switch-toast-inner {
          position: relative;
          z-index: 1;
          background: linear-gradient(180deg, #151926 0%, #0d101a 100%);
          border-radius: 12.5px;
          padding: 14px 15px 11px;
          color: #f8fafc;
          font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
          font-size: 12.5px; letter-spacing: -0.012em; line-height: 1.45;
          overflow: hidden;
        }
        .toast-ambient-rim {
          position: absolute; top: 0; left: 14%; right: 14%; height: 1.5px;
          background: linear-gradient(90deg, transparent, ${rimColor}, transparent);
          border-radius: 9999px;
          pointer-events: none;
        }
        .toast-header { display: flex; gap: 11px; align-items: flex-start; }
        .toast-avatar-wrap {
          flex: none; width: 38px; height: 38px; border-radius: 11px;
          display: grid; place-items: center;
          background: rgba(0, 0, 0, 0.45);
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 10px rgba(0, 0, 0, 0.35);
          position: relative;
        }
        .browser-avatar-sprite {
          width: 24px; height: 24px; display: block;
          background-image: url('${browserSpriteUrl}');
          background-size: 300% 300%;
          background-repeat: no-repeat;
          border-radius: 6px;
          filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
          transition: transform 0.2s ease;
        }
        .toast-avatar-wrap:hover .browser-avatar-sprite { transform: scale(1.08); }
        .toast-avatar-pulse {
          position: absolute; bottom: -2px; right: -2px;
          width: 8.5px; height: 8.5px; border-radius: 50%;
          background: #10b981; border: 2px solid #151926;
          box-shadow: 0 0 6px #10b981;
        }
        .toast-info-col { flex: 1; min-width: 0; }
        .toast-badges-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 5px; }
        .domain-badge {
          display: inline-flex; align-items: center; gap: 4.5px;
          font-family: "JetBrains Mono", ui-monospace, monospace;
          font-size: 11px; font-weight: 600;
          color: ${domainColor};
          background: ${domainBadgeBg};
          border: 1px solid ${domainBadgeBorder};
          border-radius: 5px; padding: 2px 7px;
          max-width: 175px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .device-badge {
          display: inline-flex; align-items: center; gap: 4px;
          font-size: 10.5px; font-weight: 500;
          color: #cbd5e1;
          background: rgba(255, 255, 255, 0.07);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 5px; padding: 2px 7px;
          max-width: 175px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .toast-title { margin: 0; font-size: 13.5px; font-weight: 650; color: #f8fafc; letter-spacing: -0.015em; line-height: 1.3; word-break: break-word; }
        .toast-body { margin: 7px 0 0; color: #94a3b8; font-size: 11.5px; line-height: 1.45; letter-spacing: -0.005em; word-break: break-word; }
        .toast-body strong { color: #f1f5f9; font-weight: 600; }
        .toast-actions { display: flex; gap: 7px; margin-top: 12px; align-items: center; }
        .toast-primary-btn {
          background: linear-gradient(135deg, #0ea5e9 0%, #3b82f6 50%, #6366f1 100%);
          color: #ffffff; flex: 1;
          font-family: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
          padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.2);
          box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.25);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          display: inline-flex; align-items: center; justify-content: center; gap: 5.5px;
          transition: all .16s ease;
        }
        .toast-primary-btn:hover { filter: brightness(1.1); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(2, 132, 199, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.3); }
        .toast-btn-icon { flex-shrink: 0; transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1); }
        .toast-primary-btn:hover .toast-btn-icon { transform: rotate(-30deg); }
        .toast-spin-icon { flex-shrink: 0; animation: toastSpin 0.9s linear infinite; }
        @keyframes toastSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .toast-ghost-btn {
          background: rgba(255, 255, 255, 0.06); color: #cbd5e1;
          font-family: inherit; font-size: 11.5px; font-weight: 500; cursor: pointer;
          padding: 7px 12px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1);
          flex: none; transition: all .14s ease;
        }
        .toast-ghost-btn:hover { background: rgba(255, 255, 255, 0.12); color: #ffffff; border-color: rgba(255, 255, 255, 0.18); }
        .toast-close-btn {
          background: transparent; color: #64748b; border: 0; padding: 0;
          width: 22px; height: 22px; border-radius: 6px;
          display: grid; place-items: center; cursor: pointer;
          font-size: 12px; line-height: 1; transition: all .14s ease;
          margin-top: -2px; margin-right: -2px; flex-shrink: 0;
        }
        .toast-close-btn:hover { color: #f8fafc; background: rgba(255, 255, 255, 0.1); }
        .toast-footer {
          margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.08);
          font-size: 10px; color: #64748b;
          display: flex; align-items: center; justify-content: space-between;
        }
        .toast-footer-brand { font-weight: 600; color: #94a3b8; letter-spacing: 0.03em; display: inline-flex; align-items: center; gap: 5.5px; }
        .toast-footer-logo { width: 17px; height: 17px; border-radius: 4px; display: inline-block; object-fit: cover; flex-shrink: 0; }
        .toast-footer-sec { display: inline-flex; align-items: center; gap: 4px; color: #64748b; }
        .vault-shield-dot { width: 5px; height: 5px; border-radius: 50%; background: #10b981; }
      </style>
      <div class="switch-toast-card" role="status" aria-live="polite">
        <div class="toast-border-beam-1"></div>
        <div class="toast-border-beam-2"></div>
        <div class="switch-toast-inner">
          <div class="toast-ambient-rim"></div>
          <div class="toast-header">
            <div class="toast-avatar-wrap">
              <span class="browser-avatar-sprite" style="background-position: ${spritePos};" role="img" aria-label="${escapeHtml(targetBrowserName || 'Browser')}" title="${escapeHtml(targetBrowserName || 'Browser')}"></span>
              <span class="toast-avatar-pulse" title="Active remote node"></span>
            </div>
            <div class="toast-info-col">
              <div class="toast-badges-row">
                <span class="domain-badge" title="${escapeHtml(domain)}">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="2" y1="12" x2="22" y2="12"/>
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                  </svg>
                  <span>${escapeHtml(domain)}</span>
                </span>
                ${devName ? `<span class="device-badge" title="${escapeHtml(devName)}">From ${escapeHtml(devName)}</span>` : ''}
              </div>
              <h3 class="toast-title">${escapeHtml(title)}</h3>
            </div>
            <button class="toast-close-btn" data-act="dismiss" title="Dismiss notification" aria-label="Dismiss">✕</button>
          </div>
          <p class="toast-body">${body}</p>
          <div class="toast-actions">
            ${mode === 'RESTORE' ? `
              <button class="toast-primary-btn" data-act="restore">
                <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="toast-btn-icon"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                <span>Restore Original Cookies</span>
              </button>
            ` : `
              <button class="toast-primary-btn" data-act="swap" title="${mode === 'SWAP' ? 'Swap session with ' : 'Switch to session from '}${escapeHtml(devName)}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="toast-btn-icon">
                  <path d="M16 3l4 4-4 4"/>
                  <path d="M20 7H4"/>
                  <path d="M8 21l-4-4 4-4"/>
                  <path d="M4 17h16"/>
                </svg>
                <span>${mode === 'SWAP' ? 'Swap Session' : 'Switch Session'}</span>
              </button>
            `}
            <button class="toast-ghost-btn" data-act="dismiss">Not now</button>
          </div>
          <div class="toast-footer">
            <span class="toast-footer-brand">
              ${logoUrl ? `<img src="${logoUrl}" class="toast-footer-logo" alt="Switch" />` : ''}
              <span>Switch</span>
            </span>
            <span class="toast-footer-sec">
              <span class="vault-shield-dot"></span>
              <span>Zero-knowledge encrypted</span>
            </span>
          </div>
        </div>
      </div>
    `;

    requestAnimationFrame(() => shadow.querySelector('.switch-toast-card').classList.add('in'));

    const dismissCard = () => {
      recordDismiss();
      shadow.querySelector('.switch-toast-card').classList.remove('in');
      setTimeout(() => hostEl.remove(), 220);
    };

    shadow.addEventListener('click', async (e) => {
      const targetEl = e.target.closest('[data-act]');
      const act = targetEl?.dataset?.act;
      if (!act) return;

      if (act === 'dismiss') {
        dismissCard();
        return;
      }

      if (act === 'restore') {
        targetEl.disabled = true;
        targetEl.innerHTML = `<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="toast-spin-icon"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 8"/><path d="M21 3v5h-5"/></svg><span>Restoring ${HOST}…</span>`;
        const r = await send({ type: 'RESTORE_SWAP_BACKUP', host: HOST });
        if (r && r.ok) {
          recordUsed();
        } else {
          targetEl.disabled = false;
          shadow.querySelector('.toast-body').textContent = (r && r.error) || 'Restore failed.';
        }
        return;
      }

      if (act === 'swap') {
        targetEl.disabled = true;
        targetEl.innerHTML = `<svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="toast-spin-icon"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.83 6.72 2.24L21 8"/><path d="M21 3v5h-5"/></svg><span>Switching…</span>`;
        setTimeout(() => {
          try {
            hostEl.style.display = 'none';
          } catch {}
        }, 200);

        const r = await send({
          type: 'SWAP_ACTIVE_TAB_SESSION',
          host: HOST,
          remoteCookies: otherDeviceSession?.cookies,
          deviceName: otherDeviceSession?.deviceName,
        });
        if (r && r.ok) {
          recordUsed();
        } else {
          try {
            hostEl.style.display = 'block';
          } catch {}
          targetEl.disabled = false;
          shadow.querySelector('.toast-body').textContent = r && r.error ? String(r.error) : 'Switch failed.';
        }
        return;
      }
    });
  }

  evaluate();
})();
