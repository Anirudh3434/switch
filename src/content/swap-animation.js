// ============================================================================
// Switch — Session Key Swap & Restore Animation
// Features:
// 1. Transparent glassmorphic enclosed card with refined glowing borders
// 2. Downward visual light pointers connecting action to status badges
// 3. Normal Swap: Old Key ejects left with sparks -> Fiber conduit -> New Key slides into lock socket
// 4. Restore Rollback: Swapped Key ejects from lock socket with sparks -> Reverse conduit -> Original Key slides back in and locks
// ============================================================================

(() => {
  if (window.__switchSwapAnimationLoaded) return;
  window.__switchSwapAnimationLoaded = true;

  const HOST_ID = 'switch-token-swap-anim-host';

  function playSwapAnimation({
    domain = window.location.hostname,
    originDevice = 'Local Browser',
    targetDevice = 'Remote Device',
    tokenCount = 0,
    isRollback = false,
  } = {}) {
    return new Promise((resolve) => {
      const existing = document.getElementById(HOST_ID);
      if (existing) existing.remove();

      const host = document.createElement('div');
      host.id = HOST_ID;
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      (document.body || document.documentElement).appendChild(host);

      const shadow = host.attachShadow({ mode: 'closed' });

      const cleanDev = (name) => {
        if (!name) return 'Device';
        return String(name)
          .replace(/\s+on\s+/i, ' · ')
          .replace(/\s*\([^)]*\)/g, '')
          .trim();
      };

      const oldDev = cleanDev(originDevice);
      const newDev = cleanDev(targetDevice);
      const cleanHost = String(domain).replace(/^https?:\/\//i, '').split('/')[0] || window.location.hostname;

      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

          .swap-backdrop {
            position: fixed;
            inset: 0;
            background: rgba(4, 7, 14, 0.52);
            backdrop-filter: blur(22px) saturate(160%);
            -webkit-backdrop-filter: blur(22px) saturate(160%);
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            animation: backdropIn 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", Roboto, sans-serif;
            color: #ffffff;
            overflow: hidden;
          }

          @keyframes backdropIn {
            to { opacity: 1; }
          }

          /* Ambient soft radial glow spots behind the window */
          .ambient-glow-1 {
            position: absolute;
            width: 360px;
            height: 360px;
            border-radius: 50%;
            background: ${isRollback 
              ? 'radial-gradient(circle, rgba(16, 185, 129, 0.22) 0%, transparent 70%)'
              : 'radial-gradient(circle, rgba(239, 68, 68, 0.20) 0%, transparent 70%)'};
            top: 22%;
            left: 14%;
            filter: blur(55px);
            pointer-events: none;
          }

          .ambient-glow-2 {
            position: absolute;
            width: 380px;
            height: 380px;
            border-radius: 50%;
            background: ${isRollback 
              ? 'radial-gradient(circle, rgba(239, 68, 68, 0.18) 0%, rgba(245, 158, 11, 0.15) 40%, transparent 70%)'
              : 'radial-gradient(circle, rgba(16, 185, 129, 0.22) 0%, rgba(14, 165, 233, 0.20) 40%, transparent 70%)'};
            top: 20%;
            right: 14%;
            filter: blur(55px);
            pointer-events: none;
          }

          /* Central Glassmorphic Grand Window (Transparent Enclosed Area with Glowing Border) */
          .swap-window {
            position: relative;
            width: 800px;
            max-width: calc(100vw - 36px);
            /* Transparent enclosed area with subtle frosted sheen */
            background: rgba(12, 17, 28, 0.32);
            backdrop-filter: blur(28px) saturate(180%);
            -webkit-backdrop-filter: blur(28px) saturate(180%);
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 28px;
            padding: 32px 42px 26px;
            box-shadow:
              0 32px 85px -12px rgba(0, 0, 0, 0.75),
              0 0 0 1px rgba(255, 255, 255, 0.08),
              inset 0 1px 0 rgba(255, 255, 255, 0.22),
              0 0 45px ${isRollback ? 'rgba(52, 211, 153, 0.12)' : 'rgba(56, 189, 248, 0.12)'};
            overflow: hidden;
            transform: scale(0.94) translateY(12px);
            opacity: 0;
            animation: windowEnter 0.36s cubic-bezier(0.16, 1, 0.3, 1) 0.04s forwards;
          }

          @keyframes windowEnter {
            to {
              transform: scale(1) translateY(0);
              opacity: 1;
            }
          }

          /* Title Header */
          .window-title {
            text-align: center;
            font-size: 26px;
            font-weight: 700;
            letter-spacing: -0.025em;
            color: #ffffff;
            margin-bottom: 5px;
            text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
          }

          .window-domain-pill {
            text-align: center;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 7px;
            font-size: 12px;
            color: #94a3b8;
            margin-bottom: 24px;
          }

          .window-domain-pill strong {
            color: ${isRollback ? '#34d399' : '#38bdf8'};
            font-weight: 600;
          }

          /* KEY SWAP STAGE */
          .swap-stage {
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: relative;
            min-height: 155px;
            margin-bottom: 12px;
          }

          /* CARD WRAPPERS */
          .card-key-wrap {
            position: relative;
            flex: 1;
            max-width: 265px;
            display: flex;
            align-items: center;
          }

          .card-key-wrap-left {
            justify-content: flex-start;
          }

          .card-key-wrap-right {
            justify-content: flex-end;
          }

          /* BASE CARD STYLE (Transparent frosted glass with glowing border) */
          .session-card {
            width: 100%;
            height: 120px;
            border-radius: 16px;
            padding: 16px 18px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            position: relative;
            will-change: transform, opacity, filter;
          }

          /* SWAP MODE: Left Card = Old Ejecting Red */
          .card-swap-old {
            background: linear-gradient(145deg, rgba(239, 68, 68, 0.22) 0%, rgba(225, 29, 72, 0.14) 60%, rgba(159, 18, 57, 0.18) 100%), rgba(22, 16, 22, 0.75);
            border: 1.5px solid rgba(244, 63, 94, 0.55);
            box-shadow:
              0 14px 32px rgba(225, 29, 72, 0.22),
              inset 0 1px 0 rgba(255, 255, 255, 0.2);
            animation: oldCardEject 0.95s cubic-bezier(0.16, 1, 0.3, 1) 0.18s forwards;
          }

          @keyframes oldCardEject {
            0% { transform: translateX(0); opacity: 1; filter: blur(0); }
            35% { transform: translateX(-16px); opacity: 0.95; box-shadow: 0 0 32px rgba(244, 63, 94, 0.6); }
            70% { transform: translateX(-36px) scale(0.96); opacity: 0.85; filter: blur(0.5px); }
            100% { transform: translateX(-52px) scale(0.93); opacity: 0.65; filter: blur(1px); }
          }

          /* SWAP MODE: Right Card = New Encrypted Green/Cyan Sliding In */
          .card-swap-new {
            width: calc(100% - 14px);
            background: linear-gradient(145deg, rgba(14, 165, 233, 0.24) 0%, rgba(16, 185, 129, 0.18) 60%, rgba(5, 150, 105, 0.24) 100%), rgba(10, 20, 30, 0.85);
            border: 1.8px solid #38bdf8;
            box-shadow:
              0 16px 40px rgba(14, 165, 233, 0.35),
              0 0 28px rgba(16, 185, 129, 0.3),
              inset 0 1px 0 rgba(255, 255, 255, 0.35);
            transform: translateX(45px);
            animation: newCardSlideIn 0.88s cubic-bezier(0.16, 1, 0.3, 1) 0.32s forwards;
          }

          @keyframes newCardSlideIn {
            0% { transform: translateX(45px); opacity: 0.7; }
            70% { transform: translateX(-4px); border-color: #34d399; box-shadow: 0 0 44px rgba(52, 211, 153, 0.65); }
            100% { transform: translateX(0); opacity: 1; border-color: #38bdf8; }
          }

          /* RESTORE MODE (REVERSED): Left Card = Original Key Re-inserting */
          .card-restore-original {
            background: linear-gradient(145deg, rgba(16, 185, 129, 0.25) 0%, rgba(14, 165, 233, 0.18) 60%, rgba(5, 150, 105, 0.25) 100%), rgba(10, 24, 28, 0.85);
            border: 1.8px solid #34d399;
            box-shadow:
              0 16px 40px rgba(16, 185, 129, 0.35),
              0 0 28px rgba(56, 189, 248, 0.3),
              inset 0 1px 0 rgba(255, 255, 255, 0.35);
            transform: translateX(-55px);
            opacity: 0.2;
            animation: restoreOriginalSlideIn 0.92s cubic-bezier(0.16, 1, 0.3, 1) 0.25s forwards;
          }

          @keyframes restoreOriginalSlideIn {
            0% { transform: translateX(-55px) scale(0.9); opacity: 0.2; filter: blur(6px); }
            65% { transform: translateX(4px); opacity: 0.95; border-color: #38bdf8; box-shadow: 0 0 42px rgba(56, 189, 248, 0.7); }
            100% { transform: translateX(0) scale(1); opacity: 1; border-color: #34d399; filter: blur(0); }
          }

          /* RESTORE MODE (REVERSED): Right Card = Swapped Key Ejecting Out of Socket */
          .card-restore-swapped {
            width: calc(100% - 14px);
            background: linear-gradient(145deg, rgba(239, 68, 68, 0.22) 0%, rgba(225, 29, 72, 0.14) 60%, rgba(159, 18, 57, 0.18) 100%), rgba(26, 16, 20, 0.8);
            border: 1.5px solid rgba(244, 63, 94, 0.6);
            box-shadow:
              0 14px 32px rgba(225, 29, 72, 0.25),
              inset 0 1px 0 rgba(255, 255, 255, 0.2);
            animation: restoreSwappedEject 0.95s cubic-bezier(0.16, 1, 0.3, 1) 0.15s forwards;
          }

          @keyframes restoreSwappedEject {
            0% { transform: translateX(0); opacity: 1; }
            40% { transform: translateX(18px); opacity: 0.9; box-shadow: 0 0 34px rgba(244, 63, 94, 0.65); }
            80% { transform: translateX(48px) scale(0.92); opacity: 0.45; filter: blur(5px) brightness(1.7); }
            100% { transform: translateX(75px) scale(0.85); opacity: 0.12; filter: blur(9px) brightness(2.2); }
          }

          /* Arrow indicators */
          .indicator-arrow-icon {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            width: 22px;
            height: 22px;
          }

          .arrow-left-eject {
            left: -28px;
            color: #f43f5e;
            animation: arrowNudgeLeft 0.6s ease-in-out infinite alternate;
          }

          @keyframes arrowNudgeLeft {
            from { transform: translateY(-50%) translateX(0); opacity: 0.5; }
            to { transform: translateY(-50%) translateX(-6px); opacity: 1; }
          }

          .arrow-left-restore {
            left: -28px;
            color: #34d399;
            animation: arrowNudgeRight 0.6s ease-in-out infinite alternate;
          }

          @keyframes arrowNudgeRight {
            from { transform: translateY(-50%) translateX(-6px); opacity: 0.5; }
            to { transform: translateY(-50%) translateX(0); opacity: 1; }
          }

          .arrow-right-eject {
            right: -28px;
            color: #f43f5e;
            animation: arrowNudgeRightFar 0.6s ease-in-out infinite alternate;
          }

          @keyframes arrowNudgeRightFar {
            from { transform: translateY(-50%) translateX(0); opacity: 0.5; }
            to { transform: translateY(-50%) translateX(6px); opacity: 1; }
          }

          /* Card Header Line */
          .card-header-line {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13.5px;
            font-weight: 600;
          }

          .header-red { color: #ffe4e6; }
          .header-green { color: #e6fffa; }

          .card-old-dots {
            display: flex;
            gap: 4px;
            opacity: 0.5;
          }

          .dot-row {
            display: flex;
            gap: 3.5px;
          }

          .micro-dot {
            width: 3.5px;
            height: 3.5px;
            border-radius: 50%;
          }

          /* Dissolving particles */
          .spark-particles-left {
            position: absolute;
            left: -18px;
            top: 10%;
            bottom: 10%;
            width: 24px;
            pointer-events: none;
          }

          .spark-particles-right {
            position: absolute;
            right: -18px;
            top: 10%;
            bottom: 10%;
            width: 24px;
            pointer-events: none;
          }

          .spark {
            position: absolute;
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: #fb7185;
            box-shadow: 0 0 8px #f43f5e;
            animation: sparkFly 0.8s ease-out infinite;
          }

          .spark:nth-child(1) { top: 15%; left: 0; animation-delay: 0.1s; }
          .spark:nth-child(2) { top: 35%; left: 8px; animation-delay: 0.25s; }
          .spark:nth-child(3) { top: 60%; left: -4px; animation-delay: 0.15s; }
          .spark:nth-child(4) { top: 80%; left: 6px; animation-delay: 0.35s; }

          @keyframes sparkFly {
            0% { transform: translateX(0) scale(1); opacity: 1; }
            100% { transform: translateX(-24px) scale(0.2); opacity: 0; }
          }

          .spark-reverse {
            animation: sparkFlyRight 0.8s ease-out infinite;
          }

          @keyframes sparkFlyRight {
            0% { transform: translateX(0) scale(1); opacity: 1; }
            100% { transform: translateX(24px) scale(0.2); opacity: 0; }
          }

          /* CENTER CONDUIT */
          .bridge-conduit {
            flex: 1;
            height: 90px;
            margin: 0 8px;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .bridge-svg {
            width: 100%;
            height: 100%;
            overflow: visible;
          }

          .wave-strand {
            fill: none;
            stroke-width: 2.2;
            stroke-linecap: round;
            opacity: 0.85;
          }

          /* Normal Flow: Left to Right */
          .strand-cyan {
            stroke: url(#cyanGlow);
            animation: strandFlow 1.4s ease-in-out infinite;
          }

          .strand-violet {
            stroke: url(#violetGlow);
            animation: strandFlow 1.4s ease-in-out infinite 0.2s;
          }

          .strand-blue {
            stroke: url(#blueGlow);
            animation: strandFlow 1.4s ease-in-out infinite 0.4s;
          }

          @keyframes strandFlow {
            0% { stroke-dashoffset: 0; filter: drop-shadow(0 0 3px #38bdf8); }
            50% { filter: drop-shadow(0 0 8px #00f2fe); }
            100% { stroke-dashoffset: -40; filter: drop-shadow(0 0 3px #38bdf8); }
          }

          /* Reverse Flow: Right to Left (Restore) */
          .strand-reverse-cyan {
            stroke: url(#cyanGlow);
            animation: strandReverseFlow 1.4s ease-in-out infinite;
          }

          .strand-reverse-violet {
            stroke: url(#violetGlow);
            animation: strandReverseFlow 1.4s ease-in-out infinite 0.2s;
          }

          .strand-reverse-blue {
            stroke: url(#blueGlow);
            animation: strandReverseFlow 1.4s ease-in-out infinite 0.4s;
          }

          @keyframes strandReverseFlow {
            0% { stroke-dashoffset: -40; filter: drop-shadow(0 0 3px #34d399); }
            50% { filter: drop-shadow(0 0 8px #10b981); }
            100% { stroke-dashoffset: 0; filter: drop-shadow(0 0 3px #34d399); }
          }

          /* Golden Connector Pins */
          .gold-pins-bracket-left {
            position: absolute;
            left: -11px;
            top: 24px;
            bottom: 24px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            z-index: 3;
          }

          .gold-pins-bracket-right {
            position: absolute;
            right: -11px;
            top: 24px;
            bottom: 24px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            z-index: 3;
          }

          .gold-pin {
            width: 11px;
            height: 6px;
            background: linear-gradient(90deg, #f59e0b 0%, #fbbf24 60%, #fef08a 100%);
            border-radius: 2px;
            box-shadow: 0 0 6px rgba(245, 158, 11, 0.6);
          }

          /* PCB Circuit Board & Center Lock Graphic */
          .pcb-center-lock {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            display: flex;
            align-items: center;
            justify-content: center;
          }

          .pcb-center-lock-right {
            right: 18px;
          }

          .pcb-center-lock-left {
            right: 18px;
          }

          .pcb-svg {
            width: 72px;
            height: 72px;
            opacity: 0.9;
          }

          /* Hardware Lock Slot Housing (Right) */
          .lock-slot-housing {
            position: absolute;
            right: -10px;
            top: 10px;
            bottom: 10px;
            width: 18px;
            background: #050811;
            border: 1.5px solid rgba(255, 255, 255, 0.18);
            border-radius: 8px;
            box-shadow: inset 0 0 8px rgba(0, 0, 0, 0.9);
            z-index: 1;
          }

          /* ========================================================= */
          /* DOWNWARD POINTERS (TEXT POINT DOWN TO BADGES)             */
          /* ========================================================= */
          .downward-pointers-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding: 4px 18px 12px;
          }

          .pointer-col {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
            opacity: 0.75;
            animation: pointDownPulse 1.4s ease-in-out infinite;
          }

          .pointer-col:nth-child(2) {
            animation-delay: 0.2s;
          }

          .pointer-col:nth-child(3) {
            animation-delay: 0.4s;
          }

          @keyframes pointDownPulse {
            0%, 100% { transform: translateY(0); opacity: 0.55; }
            50% { transform: translateY(3.5px); opacity: 1; }
          }

          .pointer-arrow {
            width: 16px;
            height: 16px;
          }

          .pointer-color-red { color: #f43f5e; }
          .pointer-color-purple { color: #c084fc; }
          .pointer-color-green { color: #34d399; }
          .pointer-color-cyan { color: #38bdf8; }

          /* ========================================================= */
          /* BOTTOM FEATURE BADGES: TRANSPARENT ENCLOSED CONTAINER     */
          /* ========================================================= */
          .bottom-badges-enclosed {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            padding: 12px 14px;
            /* Transparent enclosed area with refined border */
            background: rgba(255, 255, 255, 0.025);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 16px;
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
          }

          .feature-badge {
            display: flex;
            align-items: center;
            gap: 10px;
            flex: 1;
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.07);
            border-radius: 12px;
            padding: 8px 11px;
            transition: border-color 0.2s ease;
          }

          .feature-badge-icon {
            width: 30px;
            height: 30px;
            border-radius: 8px;
            display: grid;
            place-items: center;
            flex-shrink: 0;
          }

          .badge-icon-red {
            background: rgba(244, 63, 94, 0.15);
            color: #f43f5e;
            border: 1px solid rgba(244, 63, 94, 0.3);
          }

          .badge-icon-purple {
            background: rgba(168, 85, 247, 0.15);
            color: #c084fc;
            border: 1px solid rgba(168, 85, 247, 0.3);
          }

          .badge-icon-green {
            background: rgba(16, 185, 129, 0.15);
            color: #34d399;
            border: 1px solid rgba(16, 185, 129, 0.3);
          }

          .feature-badge-text {
            font-size: 11px;
            line-height: 1.35;
            color: #94a3b8;
          }

          .feature-badge-text strong {
            display: block;
            color: #f1f5f9;
            font-size: 11.5px;
            margin-bottom: 1px;
          }
        </style>

        <div class="swap-backdrop" role="dialog" aria-modal="true" aria-label="${isRollback ? 'Restoring Original Session' : 'Switching Session Keys'}">
          <div class="ambient-glow-1"></div>
          <div class="ambient-glow-2"></div>

          <!-- ENCLOSED WINDOW AREA (Transparent with glowing border) -->
          <div class="swap-window">
            <!-- MAIN TITLE -->
            <h1 class="window-title">${isRollback ? 'Restoring Original Session' : 'Switching Session Keys'}</h1>
            <div class="window-domain-pill">
              <span>Target Domain:</span>
              <strong>${cleanHost}</strong>
              <span>• ${isRollback ? 'Rollback Local Session' : 'Zero-Knowledge Vault'}</span>
            </div>

            <!-- KEY SWAP VISUAL STAGE -->
            <div class="swap-stage">
              ${!isRollback ? `
                <!-- SWAP MODE: LEFT (OLD SESSION KEY EJECTS) -->
                <div class="card-key-wrap card-key-wrap-left">
                  <svg class="indicator-arrow-icon arrow-left-eject" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 12H5M12 19l-7-7 7-7"/>
                  </svg>

                  <div class="spark-particles-left">
                    <span class="spark"></span>
                    <span class="spark"></span>
                    <span class="spark"></span>
                    <span class="spark"></span>
                  </div>

                  <div class="session-card card-swap-old">
                    <div class="card-header-line header-red">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      <span>Old Session Key</span>
                    </div>
                    <div class="card-old-dots">
                      <div class="dot-row">
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- SWAP MODE: CENTER CONDUIT (LEFT TO RIGHT FLOW) -->
                <div class="bridge-conduit">
                  <svg class="bridge-svg" viewBox="0 0 200 90" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="cyanGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.8"/>
                        <stop offset="50%" stop-color="#38bdf8" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#34d399" stop-opacity="0.9"/>
                      </linearGradient>
                      <linearGradient id="violetGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stop-color="#fb7185" stop-opacity="0.7"/>
                        <stop offset="50%" stop-color="#a855f7" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#00f2fe" stop-opacity="0.9"/>
                      </linearGradient>
                      <linearGradient id="blueGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stop-color="#fda4af" stop-opacity="0.6"/>
                        <stop offset="50%" stop-color="#6366f1" stop-opacity="0.9"/>
                        <stop offset="100%" stop-color="#10b981" stop-opacity="0.8"/>
                      </linearGradient>
                    </defs>

                    <path class="wave-strand strand-cyan" d="M 0 20 C 60 20, 40 70, 100 45 C 160 20, 140 70, 200 70" />
                    <path class="wave-strand strand-violet" d="M 0 35 C 70 35, 50 65, 100 45 C 150 25, 130 55, 200 55" />
                    <path class="wave-strand strand-blue" d="M 0 55 C 50 55, 70 25, 100 45 C 130 65, 150 35, 200 35" />
                    <path class="wave-strand strand-cyan" d="M 0 70 C 40 70, 60 20, 100 45 C 140 70, 160 20, 200 20" />
                  </svg>
                </div>

                <!-- SWAP MODE: RIGHT (NEW ENCRYPTED KEY SLIDES IN) -->
                <div class="card-key-wrap card-key-wrap-right">
                  <div class="session-card card-swap-new">
                    <!-- Gold connector pins on left edge -->
                    <div class="gold-pins-bracket-left">
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                    </div>

                    <div class="card-header-line header-green">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      <span>Encrypted Session Key</span>
                    </div>

                    <!-- PCB Circuit Board & Center Lock -->
                    <div class="pcb-center-lock pcb-center-lock-right">
                      <svg class="pcb-svg" viewBox="0 0 80 80" fill="none">
                        <rect x="22" y="22" width="36" height="36" rx="7" fill="#0c1a2e" stroke="#38bdf8" stroke-width="1.8"/>
                        <rect x="33" y="40" width="14" height="10" rx="1.5" fill="#34d399"/>
                        <path d="M36 40V36a4 4 0 0 1 8 0v4" stroke="#34d399" stroke-width="1.8"/>
                        <path d="M22 28H10M22 36H6M22 44H6M22 52H10" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M58 28H70M58 36H74M58 44H74M58 52H70" stroke="#34d399" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M28 22V10M36 22V6M44 22V6M52 22V10" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M28 58V70M36 58V74M44 58V74M52 58V70" stroke="#34d399" stroke-width="1.5" stroke-linecap="round"/>
                      </svg>
                    </div>

                    <div class="card-old-dots">
                      <div class="dot-row">
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                        <span class="micro-dot" style="background:#67e8f9;"></span>
                      </div>
                    </div>
                  </div>

                  <!-- Hardware Lock Slot on far right -->
                  <div class="lock-slot-housing"></div>
                </div>
              ` : `
                <!-- RESTORE MODE (REVERSED): LEFT (ORIGINAL KEY RE-ENGAGES) -->
                <div class="card-key-wrap card-key-wrap-left">
                  <svg class="indicator-arrow-icon arrow-left-restore" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                  </svg>

                  <div class="session-card card-restore-original">
                    <div class="card-header-line header-green">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      <span>Original Session Key</span>
                    </div>

                    <!-- PCB Circuit Board & Center Lock -->
                    <div class="pcb-center-lock pcb-center-lock-left">
                      <svg class="pcb-svg" viewBox="0 0 80 80" fill="none">
                        <rect x="22" y="22" width="36" height="36" rx="7" fill="#08221c" stroke="#34d399" stroke-width="1.8"/>
                        <rect x="33" y="40" width="14" height="10" rx="1.5" fill="#38bdf8"/>
                        <path d="M36 40V36a4 4 0 0 1 8 0v4" stroke="#38bdf8" stroke-width="1.8"/>
                        <path d="M22 28H10M22 36H6M22 44H6M22 52H10" stroke="#34d399" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M58 28H70M58 36H74M58 44H74M58 52H70" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M28 22V10M36 22V6M44 22V6M52 22V10" stroke="#34d399" stroke-width="1.5" stroke-linecap="round"/>
                        <path d="M28 58V70M36 58V74M44 58V74M52 58V70" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round"/>
                      </svg>
                    </div>

                    <div class="card-old-dots">
                      <div class="dot-row">
                        <span class="micro-dot" style="background:#6ee7b7;"></span>
                        <span class="micro-dot" style="background:#6ee7b7;"></span>
                        <span class="micro-dot" style="background:#6ee7b7;"></span>
                        <span class="micro-dot" style="background:#6ee7b7;"></span>
                        <span class="micro-dot" style="background:#6ee7b7;"></span>
                        <span class="micro-dot" style="background:#6ee7b7;"></span>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- RESTORE MODE: CENTER CONDUIT (RIGHT TO LEFT REVERSE FLOW) -->
                <div class="bridge-conduit">
                  <svg class="bridge-svg" viewBox="0 0 200 90" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="cyanGlow" x1="100%" y1="0%" x2="0%" y2="0%">
                        <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.8"/>
                        <stop offset="50%" stop-color="#38bdf8" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#34d399" stop-opacity="0.9"/>
                      </linearGradient>
                      <linearGradient id="violetGlow" x1="100%" y1="0%" x2="0%" y2="0%">
                        <stop offset="0%" stop-color="#fb7185" stop-opacity="0.7"/>
                        <stop offset="50%" stop-color="#a855f7" stop-opacity="1"/>
                        <stop offset="100%" stop-color="#00f2fe" stop-opacity="0.9"/>
                      </linearGradient>
                      <linearGradient id="blueGlow" x1="100%" y1="0%" x2="0%" y2="0%">
                        <stop offset="0%" stop-color="#fda4af" stop-opacity="0.6"/>
                        <stop offset="50%" stop-color="#6366f1" stop-opacity="0.9"/>
                        <stop offset="100%" stop-color="#10b981" stop-opacity="0.8"/>
                      </linearGradient>
                    </defs>

                    <path class="wave-strand strand-reverse-cyan" d="M 0 20 C 60 20, 40 70, 100 45 C 160 20, 140 70, 200 70" />
                    <path class="wave-strand strand-reverse-violet" d="M 0 35 C 70 35, 50 65, 100 45 C 150 25, 130 55, 200 55" />
                    <path class="wave-strand strand-reverse-blue" d="M 0 55 C 50 55, 70 25, 100 45 C 130 65, 150 35, 200 35" />
                    <path class="wave-strand strand-reverse-cyan" d="M 0 70 C 40 70, 60 20, 100 45 C 140 70, 160 20, 200 20" />
                  </svg>
                </div>

                <!-- RESTORE MODE: RIGHT (SWAPPED KEY EJECTS OUT OF HARDWARE SOCKET) -->
                <div class="card-key-wrap card-key-wrap-right">
                  <div class="session-card card-restore-swapped">
                    <!-- Gold connector pins disconnecting on left -->
                    <div class="gold-pins-bracket-left">
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                      <span class="gold-pin"></span>
                    </div>

                    <div class="card-header-line header-red">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f43f5e" stroke-width="2.2">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                      </svg>
                      <span>Swapped Session Key</span>
                    </div>

                    <div class="card-old-dots">
                      <div class="dot-row">
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                        <span class="micro-dot" style="background:#fca5a5;"></span>
                      </div>
                    </div>
                  </div>

                  <div class="spark-particles-right">
                    <span class="spark spark-reverse"></span>
                    <span class="spark spark-reverse"></span>
                    <span class="spark spark-reverse"></span>
                  </div>

                  <svg class="indicator-arrow-icon arrow-right-eject" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h14M12 5l7 7-7 7"/>
                  </svg>

                  <!-- Hardware Lock Slot on far right (uncoupling) -->
                  <div class="lock-slot-housing"></div>
                </div>
              `}
            </div>

            <!-- TRANSPARENT ENCLOSED CONTAINER FOR BOTTOM STATUS BADGES -->
            <div class="bottom-badges-enclosed">
              ${!isRollback ? `
                <div class="feature-badge">
                  <div class="feature-badge-icon badge-icon-red">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M19 12H5M12 19l-7-7 7-7"/>
                    </svg>
                  </div>
                  <div class="feature-badge-text">
                    <strong>Old Session Key</strong>
                    <span>Safely decommissioned & saved</span>
                  </div>
                </div>

                <div class="feature-badge">
                  <div class="feature-badge-icon badge-icon-purple">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>
                  </div>
                  <div class="feature-badge-text">
                    <strong>Transfer Bridge</strong>
                    <span>Zero-knowledge conduit rays</span>
                  </div>
                </div>

                <div class="feature-badge">
                  <div class="feature-badge-icon badge-icon-green">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                  </div>
                  <div class="feature-badge-text">
                    <strong>Encrypted Key Locked</strong>
                    <span>Session authenticated into socket</span>
                  </div>
                </div>
              ` : `
                <div class="feature-badge">
                  <div class="feature-badge-icon badge-icon-green">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M5 12h14M12 5l7 7-7 7"/>
                    </svg>
                  </div>
                  <div class="feature-badge-text">
                    <strong>Original Session Restored</strong>
                    <span>Local credentials re-engaged</span>
                  </div>
                </div>

                <div class="feature-badge">
                  <div class="feature-badge-icon badge-icon-purple">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>
                  </div>
                  <div class="feature-badge-text">
                    <strong>Rollback Conduit</strong>
                    <span>Reverse session token flow</span>
                  </div>
                </div>

                <div class="feature-badge">
                  <div class="feature-badge-icon badge-icon-red">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                  </div>
                  <div class="feature-badge-text">
                    <strong>Swapped Key Ejected</strong>
                    <span>Remote session uncoupled</span>
                  </div>
                </div>
              `}
            </div>
          </div>
        </div>
      `;

      // Allow 2.1 seconds for user to clearly understand the animation, then resolve cleanly
      setTimeout(() => {
        resolve({ ok: true });
        const backdrop = shadow.querySelector('.swap-backdrop');
        if (backdrop) {
          backdrop.style.transition = 'opacity 0.28s ease-out';
          backdrop.style.opacity = '0';
        }
      }, 2100);
    });
  }

  // Runtime listener from background / popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PLAY_SWAP_TOKEN_ANIMATION') {
      playSwapAnimation({
        domain: msg.domain,
        originDevice: msg.originDevice,
        targetDevice: msg.targetDevice,
        tokenCount: msg.tokenCount,
        isRollback: !!msg.isRollback,
      }).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }
  });

  window.__playSwitchTokenSwapAnimation = playSwapAnimation;
})();
