# Switch — Product Overview & Screen-by-Screen Guide

> **Zero-Knowledge Cross-Browser Session Bridge**  
> Move active web login sessions between Chromium browsers (Chrome, Edge, Brave and similar) and computers with zero-knowledge end-to-end encryption. This is a pre-release build; Firefox is not supported yet.

---

## 1. What is Switch?

**Switch** is a privacy-first browser extension and companion sync service that allows users to instantly transfer, swap, or adopt active login sessions between different browsers and devices without needing to re-enter credentials, passkeys, or multi-factor authentication (2FA) prompts.

### The Problem It Solves
- **Browser Switching Friction**: You are logged into work platforms (e.g., Stripe, AWS, GitHub, Zapier) on Microsoft Edge on Windows, but prefer testing or debugging in Google Chrome or Brave.
- **Cross-Computer Workflows**: Moving from a desktop workstation to a laptop usually requires logging into dozens of sites all over again.
- **Account Toggling**: Developers and QA engineers constantly need to alternate between test accounts, staging personas, and production logins.

### The Zero-Knowledge Guarantee
Switch is engineered with a **zero-knowledge cryptographic vault**:
- Master passwords derive an encryption key locally via **PBKDF2** (600,000 iterations + SHA-256).
- All session tokens and cookies are sealed locally using **AES-256-GCM** before any sync.
- The sync server and MongoDB store only ciphertext envelopes; the server operator **cannot read** user session cookies, plaintext tokens, or passwords.

---

## 2. Popup UI & User Journey (Screen-by-Screen)

The extension popup (`src/popup/popup.html`) follows a structured, intuitive 3-step progressive onboarding model, leading into a 3-tab application dashboard.

```
┌────────────────────────────────────────────────────────┐
│                   SWITCH POPUP FLOW                    │
│                                                        │
│  [Step 1: Auth] ──> [Step 2: Consent] ──> [Main App]   │
│   • Log In / Join    • Data Disclosure     ├── Cookies │
│   • PBKDF2 Local     • Grant Permission    ├── Devices │
│                                            └── Account │
└────────────────────────────────────────────────────────┘
```

---

### Step 1: Authentication Screen (`#view-login`)

When opened for the first time or after logging out, Switch displays the Authentication Screen.

```
┌──────────────────────────────────────────────┐
│  [Logo] Switch                               │
│         Step 1 — Sign in to continue         │
├──────────────────────────────────────────────┤
│  [ Log In (Active) ]   [ Create Account ]    │
│                                              │
│  Email                                       │
│  [ user@example.com                        ] │
│                                              │
│  Password                                    │
│  [ ••••••••••••••••                        ] │
│                                              │
│  Sync Server             Default: :8080      │
│  [ http://localhost:8080                   ] │
│                                              │
│  [            LOG IN (Button)              ] │
│                                              │
│  🔒 Zero-knowledge. Passwords derive an auth │
│     hash locally using PBKDF2. Server never  │
│     receives plaintext credentials.          │
└──────────────────────────────────────────────┘
```

#### Detailed Elements:
1. **Brand Hero**: High-resolution Switch logo with subtitle indicating the step.
2. **Mode Switcher Tabs**: Smooth toggle between **Log In** and **Create Account**.
3. **Form Fields**:
   - **Email Input**: User's account identifier.
   - **Password Input**: Master password used to derive the local encryption vault key.
   - **Sync Server Input**: Allows connecting to a local backend (`http://localhost:8080`) or a self-hosted cloud instance.
4. **Submit Button**: Executes client-side PBKDF2 key derivation and validates credentials with the backend.
5. **Trust Notice**: Explains client-side cryptographic hashing so users have complete confidence in their privacy.

---

### Step 2: Consent & Permissions Screen (`#view-consent`)

To comply strictly with Chrome Web Store User Data policies, Switch enforces an explicit consent gate before any local browser cookies are read.

```
┌──────────────────────────────────────────────┐
│  [Shield] Step 2 — Consent                   │
│           Data access permissions            │
├──────────────────────────────────────────────┤
│  Switch inspects and lists the cookies       │
│  stored in your browser so you can view,     │
│  search, and analyze session state directly. │
│                                              │
│  ┌────────────────────┬────────────────────┐ │
│  │ Data read          │ Cookie store       │ │
│  │ Where it goes      │ Local browser      │ │
│  │ Transmission       │ None (local only)  │ │
│  └────────────────────┴────────────────────┘ │
│                                              │
│  [   I UNDERSTAND & GRANT CONSENT (Btn)    ] │
│  You can withdraw consent at any time.       │
└──────────────────────────────────────────────┘
```

#### Detailed Elements:
1. **Shield Icon & Header**: Clear visual indicator that this is a privacy checkpoint.
2. **Plain-English Explanation**: Outlines exactly what data the extension accesses.
3. **Data Disclosure Breakdown Table**:
   - **Data read**: Local browser cookie store.
   - **Where it goes**: Displayed locally in your browser popup.
   - **External transmission**: None without explicit user sync; when synced, payloads are AES-256-GCM encrypted.
4. **Consent Button**: Permanently saves consent to `chrome.storage.local` and seamlessly unlocks Step 3.

---

### Step 3: Main Application (`#view-app`)

Once authenticated and consented, users enter the primary workspace. The header features the Switch logo and a 3-tab segmented navigation bar:
- **Cookies**: Live cookie inspector and active tab smart swap controller.
- **Devices**: Connected browsers and multi-device manager.
- **Account**: User profile and session sign-out.

---

#### Tab 1: Cookies Inspector (`#tab-cookies`)

This is the central command center of Switch.

```
┌────────────────────────────────────────────────────────┐
│ [Logo] Switch          [Cookies (85)] [Devices] [Acct] │
├────────────────────────────────────────────────────────┤
│ ┌─ ACTIVE TAB SMART SWAP BANNER ─────────────────────┐ │
│ │ 🟢 ACTIVE TAB   zapier.com    ⚡ Both Logged In     │ │
│ │ [Edge Logo] Edge 155 · Windows                     │ │
│ │             29 remote tokens • 15 local cookies    │ │
│ │             [ ↺ Go Back ]  [ ⇄ Swap Session ]      │ │
│ └────────────────────────────────────────────────────┘ │
│                                                        │
│ ┌─ TOOLBAR ROW 1: SCOPE & ACTIONS ───────────────────┐ │
│ │ [🟢 Local Browser ▾] [All Domains ▾]  [🔄] [⤢] [📋]│ │
│ └────────────────────────────────────────────────────┘ │
│ ┌─ TOOLBAR ROW 2: SEARCH ────────────────────────────┐ │
│ │ 🔍 [Search by name, domain, or value...        ][✕]│ │
│ └────────────────────────────────────────────────────┘ │
│ ┌─ TOOLBAR ROW 3: FILTER STRIP & DOMAIN COUNT ───────┐ │
│ │ [All (85)] [🔑 Auth (18)] [🔒 Secure] [⏱ Session] │ │
│ │                                         24 domains │ │
│ └────────────────────────────────────────────────────┘ │
│                                                        │
│ ▼ 🌐 zapier.com (15 cookies • 4 auth) [Revoke] [📋]   │
│   ├── zapier_session (Auth • Secure • HttpOnly)      │
│   ├── __Host-auth-token (JWT • Auth • Secure)        │
│   └── ...                                            │
│ ▶ 🌐 stripe.com (22 cookies • 6 auth)  [Sync]   [📋]   │
└────────────────────────────────────────────────────────┘
```

##### 1. Active Tab Smart Swap Banner (Highlighted Hero Row)
Whenever your currently active tab matches a domain with sessions from other devices:
- **Glowing Visual Accent**: Dynamic border that highlights the current site.
- **Top Status Line**:
  - Live pulse dot + `ACTIVE TAB` or `ACTIVE TAB · SWAPPED` pill.
  - Active domain badge (`zapier.com`).
  - Status badge: `⚡ Both Logged In`, `🔑 Cloud Session Ready`, or `⚡ Swapped Session Active`.
- **Hero Device & Token Row**:
  - High-fidelity visual browser SVG logo set used in design mockups (Chrome, Edge, Firefox, Brave, Safari, Opera). Firefox assets are illustrative only; the extension itself is Chromium-only.
  - Clean device name (`Edge 155 · Windows`).
  - Real-time token breakdown (`29 remote tokens • 15 local cookies`).
- **Interactive Action Buttons**:
  - **`⇄ Swap Session`**: Flips the current browser's cookies with the remote session.
  - **`⚡ Inject & Sign In`**: Injects tokens if the current browser is logged out.
  - **`↺ Go Back`**: Restores the snapshot saved right before swapping.

##### 2. Three-Row Control Toolbar
- **Row 1 (Scope Selectors & Actions)**:
  - **Device Scope Select**: Choose between `🟢 Local Browser`, `☁️ All Devices`, or specific paired devices.
  - **Domain Filter Dropdown**: Quickly narrow view to any specific host.
  - **Quick Action Icons**:
    - `🔄 Refresh`: Reloads local cookie store.
    - `⤢ Toggle Groups`: One-click expand/collapse all domain accordions.
    - `📋 Copy JSON`: Exports currently visible cookies formatted as clean JSON.
- **Row 2 (Search Field)**:
  - Real-time fuzzy filtering across cookie names, domains, and values.
  - Integrated `✕` clear button to reset queries instantly.
- **Row 3 (Filter Strip & Domain Stats)**:
  - Quick filter pills with embedded counts: `All`, `🔑 Auth`, `🔒 Secure`, `⏱ Session`.
  - Right-aligned domain counter badge (e.g. `24 domains`).

##### 3. Cookie Accordion Feed
- **Domain Accordion Headers**:
  - Domain title, total cookie count, and highlighted auth token badge.
  - **Swap / Adopt Button**: Easily switch with remote session or inject into this browser.
  - **Delete Session & Tokens Button (`🗑️ Delete`)**: Triggers the safety confirmation modal to permanently purge tokens across cookies, cloud server, and local storage.
  - **Copy Domain JSON Button**: Copies all tokens for this domain to clipboard.
- **Cookie Cards**:
  - Cookie name and expandable value snippet.
  - Attribute tags: `Secure`, `HttpOnly`, `SameSite`, `JWT`, `Auth`, `Host-Only`, `Partitioned`.
  - Expiration time (or `Session` tag).
  - Quick action buttons: `[ Show ]`, `[ Copy ]`, and `[ 🗑️ Delete Cookie ]`.
  - **JWT Inspector**: Decodes JWT headers and payload claims inline (e.g., expiry, subject, issuer) without needing external tools.

##### 4. Safety Confirmation Modal (`#confirm-modal`)
To prevent accidental data loss, clicking any **Delete** button prompts a high-contrast safety modal:
- **Title & Domain**: Explicitly shows `Delete Session for <domain>?`.
- **Three-Layer Checklist**:
  - 🍪 **Browser Cookies**: Clears all local cookies for this domain.
  - ☁️ **Sync Server Vault**: Erases the encrypted session from MongoDB.
  - 💾 **Local Storage**: Purges swap backups and snapshot history.
- **Warning Notice**: Confirms the user will be logged out on the current browser.
- **Actions**: `[ Cancel ]` or `[ Delete Everything ]`.

---

#### Tab 2: Devices Management (`#tab-devices`)

Switch provides a unified view of your browsing fleet across machines and browsers.

```
┌────────────────────────────────────────────────────────┐
│ [Logo] Switch          [Cookies] [Devices (2)] [Acct]  │
├────────────────────────────────────────────────────────┤
│ THIS DEVICE                                            │
│ ┌────────────────────────────────────────────────────┐ │
│ │ [Chrome Logo] Chrome · Windows     [This Browser]  │ │
│ │               Device ID: dev_74f9b201a3c5          │ │
│ │ ┌───────────────────┬────────────────────────────┐ │ │
│ │ │ Browser: Chrome   │ OS: Windows 10/11          │ │ │
│ │ │ Machine ID: sys_1 │ Status: Registered & Live  │ │ │
│ │ └───────────────────┴────────────────────────────┘ │ │
│ └────────────────────────────────────────────────────┘ │
│                                                        │
│ OTHER CONNECTED DEVICES                         [ 🔄 ] │
│ ┌────────────────────────────────────────────────────┐ │
│ │ [Edge Logo] Edge 155 · Windows   [🖥️ Same PC] [2m] │ │
│ │             Device ID: dev_88a4c112e091            │ │
│ │                                                    │ │
│ │ Synced Sessions:                                   │ │
│ │ • zapier.com (29 tokens) • stripe.com (14 tokens)  │ │
│ │                                                    │ │
│ │ [ Revoke Device ]                                  │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

##### Detailed Elements:
1. **This Device Card**:
   - Visual browser brand icon and auto-detected OS.
   - Unique persistent Device ID (`dev_...`) generated via CSPRNG.
   - Machine ID (`sys_...`) to correlate different browsers on the same physical computer.
   - Status badge showing active registration.
2. **Other Connected Devices List**:
   - Visual browser logos for remote browsers.
   - **`🖥️ Same Computer` Badge**: Intelligently identifies when Edge and Chrome are running on the same PC.
   - **Relative Time Badge**: Live activity tracker (`2m ago`, `Just now`).
   - **Synced Sessions Summary**: Lists domains synced by this device with token counts.
   - **Revoke Device Button**: Revokes tokens associated with this device.

---

#### Tab 3: Account Screen (`#tab-account`)

A minimalist, focused identity screen.

```
┌────────────────────────────────────────────────────────┐
│ [Logo] Switch          [Cookies] [Devices] [Account]   │
├────────────────────────────────────────────────────────┤
│ ┌─ PROFILE CARD ─────────────────────────────────────┐ │
│ │ (User Icon) Signed in as                           │ │
│ │             user@example.com                       │ │
│ │             🟢 Active account                      │ │
│ │                                                    │ │
│ │ Email:        user@example.com                     │ │
│ │ Status:       Authenticated (Zero-Knowledge)       │ │
│ │                                                    │ │
│ │ [              LOG OUT (Red Button)              ] │ │
│ └────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

##### Detailed Elements:
1. **Profile Identity Badge**: Displays logged-in user email with live connection pulse.
2. **Data Table**: Confirms authentication state.
3. **Log Out Button**: Clears cached access tokens, wipes user session data from local extension storage, and safely returns to Step 1.

---

## 3. In-Page Intelligent Toast Widget

In addition to the popup, Switch features an **in-page session bridge** (`src/content/login-detector.js`) that appears non-intrusively in the bottom-right corner of supported web pages.

```
┌────────────────────────────────────────────────────┐
│ [ ⇄ ]  🌐 zapier.com                           [✕] │
│        Swap zapier.com session                     │
│        Another active zapier.com session was found │
│        on Edge 155 · Windows (29 tokens).          │
│                                                    │
│  [ ⇄ Swap zapier.com Session ]       [ Not now ]   │
│                                                    │
│  SWITCH                   Zero-knowledge encrypted │
└────────────────────────────────────────────────────┘
```

### Key Capabilities:
1. **Shadow DOM Isolation**: Rendered inside a closed Shadow Root so the host page’s CSS never breaks the widget, and the widget’s styles never leak into the host page.
2. **Prominent Domain Pill**: Displays `🌐 <domain>` in high-contrast cyan/emerald/purple font.
3. **Context-Aware Scenarios**:
   - **Already Logged In**: Suggests `⇄ Swap [domain] Session` with clean device name (`Edge 155 · Windows`).
   - **Logged Out**: Suggests `⚡ Inject & Sign In to [domain]` to bypass manual login forms.
   - **Swapped / Active Backup**: Suggests `↺ Restore Original [domain] Session` to undo the swap.
4. **Interactive Dismissal**:
   - **`✕` Top-Right Button & `Not now` Button**: Dismisses the card with a smooth slide animation.
   - **Session Memory**: Uses `sessionStorage` to prevent re-prompting on the same domain during the active browser tab session.
5. **Search Engine Exclusion**:
   - Automatically excludes `google.com`, `www.google.com`, `google.co.in`, `bing.com`, `duckduckgo.com`, `search.yahoo.com`, `baidu.com`, and other search engines from showing session prompts.

---

## 4. Security & Edge-Case Architecture

Switch handles the notoriously complex world of modern browser cookies:

| Feature | How Switch Handles It |
|---|---|
| **Domain vs Host-Only** | Distinguishes between `.example.com` (domain cookie) and `example.com` (host-only cookie) to prevent scope widening. |
| **`__Host-` Prefix** | Enforces `Secure=true`, `Path=/`, and host-only attributes as required by RFC 6265bis. |
| **`__Secure-` Prefix** | Enforces `Secure=true`. |
| **SameSite Restrictions** | Enforces `Secure=true` for `SameSite=None`; normalises unsupported `sameSite` values to a safe accepted value. |
| **Partitioned Cookies (CHIPS)** | Preserves the `partitionKey` so partitioned cookies load into the proper origin bucket. |
| **Anti-Looping Protection** | If a site rejects a session due to device/TLS binding, Switch suppresses continuous prompts to avoid infinite loops. |

---

## 5. Persistent Swap Store & Rollback Safety System

To eliminate confusion about which token belongs to which browser/device, Switch maintains a persistent collection store: `active_swaps`.

### 5.1 Persistent Swap Record Schema
When a user swaps a domain session:
```ts
interface SwapRecord {
  host: string;              // e.g. "dashboard.stripe.com"
  rootDomain: string;        // e.g. "stripe.com"
  swappedAt: number;         // Timestamp of swap
  isLocked: boolean;         // true -> strict swap guard active

  // Origin (The session that was originally on this browser before swap)
  origin: {
    deviceId: string;
    deviceName: string;      // e.g. "Chrome 120 on Windows 10/11"
    browser: string;         // "Chrome"
    os: string;              // "Windows 10/11"
    cookies: Cookie[];       // Full cookies snapshot
    cookieCount: number;
    tokens: TokenSummary[];  // Masked token breakdown
  };

  // Target (The session interchanged from the remote device/browser)
  target: {
    deviceId: string;
    deviceName: string;      // e.g. "Brave on macOS"
    browser: string;         // "Brave"
    os: string;
    cookies: Cookie[];       // Applied remote cookies
    cookieCount: number;
    tokens: TokenSummary[];
  };
}
```

### 5.2 Strict Swap Guard (No 3rd Device Chaining)
- While a domain is in an active swapped state, **chaining swaps to a 3rd device or 3rd browser is prohibited**.
- The extension unlocks **only the Rollback option (`↺ Go Back`)**:
  - **Active Tab Banner**: Hides the `⇄ Swap` button and shows `🔒 Swapped Session Active (Rollback Only)` alongside `[ ↺ Go Back ]`.
  - **Popup Domain Feed**: The swapped domain row replaces `⇄ Swap` with a prominent `[ ↺ Rollback ]` button and displays a `⚡ Swapped` pill.
  - **Domain Details**: Expanding the swapped domain reveals a dedicated comparison box showing **Origin (Backed Up)** vs **Active (Applied)** device, browser, and cookie metrics.
  - **Webpage Toast**: Suppresses any swap prompts with other devices and offers only `↺ Restore Original Cookies`.
  - **Background Worker**: Rejects any incoming swap request for an already swapped domain until rolled back.

### 5.3 Clean Rollback Mechanics
When the user clicks `↺ Go Back` or `↺ Rollback`:
1. **Purges Current Swapped Cookies**: Removes any cookies matching the domain to avoid token contamination or lingering session keys.
2. **Restores Exact Original Cookies**: Re-injects the original `origin.cookies` snapshot into the browser's cookie jar.
3. **Deletes the Swap Record**: Purges the record from `active_swaps` and clears any associated backup keys (clean slate).
4. **Reloads Tab**: The active tab refreshes cleanly back into the user's authentic local session.

---

## 6. Technology Stack Summary

- **Frontend / Extension**: Manifest V3 (MV3), Vanilla ES Modules, Shadow DOM, Custom Modern CSS (Glassmorphism & Cyber Aesthetics), SVG Browser Visual Logos.
- **Cryptography**: Web Crypto API (SubtleCrypto), PBKDF2 (600k rounds SHA-256), AES-256-GCM.
- **Backend Sync Server**: Node.js HTTP Server (`src/server.js`), MongoDB Atlas / Local MongoDB (`switch` database).
- **Communication**: Chrome Extensions Messaging API (`chrome.runtime.sendMessage`, `chrome.tabs.sendMessage`).

---

*Switch — Zero-knowledge session portability across browsers and devices.*

