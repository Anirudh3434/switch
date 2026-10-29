# Switch — Session Bridge

Save a login session on Browser A, restore it on Browser B. Client-side
encrypted; the sync server (or exported file) never sees plaintext.

**Status: pre-release.** Chromium only (Chrome, Edge, Brave and similar). There
is no Firefox build and no published store listing; install from an unpacked
build. Sync is optional and manual by default.

📖 **Complete Product & UI Guide**: See [PRODUCT_OVERVIEW.md](PRODUCT_OVERVIEW.md) for full screen-by-screen breakdown.

---

## Load it

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this folder
3. Open any site → click the icon → Accept consent → **Give access to this site** → **Save this session**
4. Open the same site in another browser with the extension → **Restore on this browser**
   (or **Export encrypted file…** here and **Import file…** there — no server needed)

Firefox is **not supported**: Switch relies on Chromium extension APIs and ships
no Gecko build. Export/import compatibility across unrelated browsers is not
guaranteed because cookie formats differ.

---

## How it works

```
┌── Browser A ──────────────────────────┐
│  cookies.getAll(url, partitionKey)    │  ← walks parent domains, keeps
│  scripting.executeScript → localStorage│    partitionKey + firstPartyDomain
└──────────────┬────────────────────────┘
               │ AES-256-GCM (vault key)
               │ vault key wrapped by PBKDF2(password)
               ▼
     envelope { v, kdf, wrapped, payload }   ← opaque to any server
               │
     ┌─────────┴──────────┐
     │ export .json file  │  OR  your own E2EE backend
     └─────────┬──────────┘
               ▼
┌── Browser B ──────────────────────────┐
│  1. cookies.set()  — BEFORE navigation│
│  2. queue localStorage → storage.local│
│  3. load site, then reload once       │
│  content script @ document_start      │
│  writes localStorage before app boots │
└───────────────────────────────────────┘
```

### Files

| Path | Role |
|---|---|
| `manifest.json` | MV3. `cookies` + **optional** host permissions only — no `<all_urls>` at install |
| `src/background.js` | Message router (MV3 service worker) |
| `src/lib/cookies.js` | Capture/restore with all the cookie-attribute landmines handled |
| `src/lib/snapshot.js` | Orchestration + per-origin content-script registration |
| `src/lib/crypto.js` | PBKDF2 → AES-GCM vault, sealed payloads |
| `src/content/restore.js` | `document_start` localStorage injector |
| `src/popup/*` | UI |

---

## Cookie edge cases — already handled in `lib/cookies.js`

- `domain: ".example.com"` = domain cookie → pass `domain`.
  `domain: "example.com"` = **host-only** → **omit** `domain`, or you silently
  widen the cookie's scope.
- `__Host-*`: must be `secure`, `path=/`, host-only. Forced.
- `__Secure-*`: `secure` forced.
- `SameSite=None` without `Secure` → the browser discards it. Forced.
- **Partitioned (CHIPS)** cookies: `partitionKey` is preserved both ways, or the
  cookie lands in a bucket the site never reads.
- Session cookies stay session cookies — no fake `expirationDate`.

---

## Known limitations (be honest with your users)

1. **The site can still reject the session.** Device binding, TLS/JA3
   fingerprinting, IP reputation and "new device" checks mean banks, Google,
   Netflix and Cloudflare-protected sites will often force a re-login *even with
   perfect cookies*. The extension reports this honestly — it cannot fix it.
2. **Passkeys are non-exportable by design.** FIDO2 credentials never leave the
   device. Nothing any extension can do.
3. **Tokens in memory.** SPAs holding an access token in a JS variable leave
   nothing to capture. Only `localStorage`/cookies are reachable.
4. **Rotating OAuth refresh tokens.** Using a copied refresh token on Browser B
   can *revoke* Browser A's session (RFC 6819 / OAuth 2.1 rotation).
5. **No mobile.** iOS Safari extensions can't touch cookies; Android Chrome
   extensions are new and limited.
6. **No Safari.** No usable cookies API + per-site permission gating + ITP.
7. **`localStorage` restored at `document_start` can race a very fast SPA.**
   Mitigated by a follow-up reload — after the first apply, localStorage
   persists natively, so subsequent loads are always clean. IndexedDB is not
   yet supported (v2).
8. **Encryption at rest does not protect a compromised browser.** Snapshots are
   sealed with the vault key and host-bound AAD, and legacy plaintext is
   re-sealed the first time it is read. But while the vault is unlocked the key
   is in memory, so malware inside the browser profile can read it.

---

## Roadmap

- [ ] Argon2id (WASM) replacing PBKDF2
- [x] Encrypt snapshots at rest with the vault key
- [ ] IndexedDB + Cache Storage capture (large; needs size caps)
- [x] Backend: E2EE blob store, per-record versioning, conflict detection
- [x] Per-site explicit sync + opt-in auto-sync (default off)
- [ ] **Team handoff** — share one site's session with a teammate, revoke later.
      Server-side pieces exist; the launch UI does not expose them.
- [ ] Firefox container (`contextualIdentities`) support — requires a Gecko port
- [ ] Passkey wrapping for the vault key itself

---

## Threat model (read this before you deploy a server)

- **You will be the highest-value target in your users' stack.** A breach gives
  attackers *live* sessions to their bank and Gmail — far worse than a password
  manager breach (hashed passwords).
- **Your extension update pipeline is the attack vector.** One compromised
  signing key or one malicious dependency = mass session theft. Keep the
  dependency count near zero (this MVP has zero runtime deps) and publish the
  source.
- **E2EE + recovery is a real tradeoff.** Forget the password and the vault is
  gone. That's why Google refuses to E2EE-sync cookies. Plan recovery keys or
  passkey-wrapping.
- **Regulated data.** Cookies are personal data under GDPR and India's DPDP Act
  2023. Breach notification obligations attach to *you*.

## Related work

- **[CookieCloud](https://github.com/easychen/CookieCloud)** — the closest
  existing project (self-hosted, E2E-ish, cookies + localStorage). Its crypto is
  `MD5(uuid+password) → AES-CBC` and it restores by rebuilding URLs that lose
  host-only vs domain-cookie distinction. This repo deliberately does neither.
- **Firefox Sync** — browser vendors already sync cookies; Firefox even does it
  E2EE. That's the precedent proving this is technically legitimate.
- **AdsPower / Multilogin / GoLogin** — the commercial proof people pay for
  profile sync, at $8–100+/profile/mo.
