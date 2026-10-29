# Launch blockers — decisions the code cannot make

**Updated:** 28 October 2026

The engineering work is complete enough to run. The items below are **not code
bugs**; they are facts, accounts, and legal decisions only the project owner can
supply. Anything marked **BLOCKER** must be resolved before a public launch.
Anything marked **HIGH** should be resolved before accepting real users' data.

No personal, payment, or legal details have been invented in the repository.
Placeholders are deliberately obvious so they cannot be mistaken for real values.

---

## 1. Legal entity and contacts — **BLOCKER**

| Item | Where it appears | Status |
|---|---|---|
| Legal entity name | `PRIVACY_POLICY.md`, `TERMS_OF_SERVICE.md`, `website/config.js` | Placeholder |
| Registered address | `TERMS_OF_SERVICE.md` | Placeholder |
| Governing law / jurisdiction / venue | `TERMS_OF_SERVICE.md`, `website/config.js` | Placeholder |
| Privacy contact email | `PRIVACY_POLICY.md`, `PRIVACY.md`, `src/onboarding/privacy.html`, `website/config.js` | Placeholder |
| Security contact email | `PRIVACY_POLICY.md`, `PRIVACY.md`, `website/config.js` | Placeholder |
| Support contact email | `website/config.js`, all public pages | Placeholder |
| India DPDP grievance officer (name, email, response window) | `PRIVACY_POLICY.md`, `src/onboarding/privacy.html` | Placeholder |
| EU/UK representative (if required) | `PRIVACY_POLICY.md` | Placeholder |
| Liability floor amount | `TERMS_OF_SERVICE.md` | Placeholder |

**Why it blocks:** a privacy policy naming a non-existent controller is not a
valid notice. Consumer terms with an unconfigured jurisdiction are unenforceable
and may breach marketplace requirements.

**Done when:** every `[ ... TO BE CONFIGURED ]` and `.example` placeholder is
replaced, and `grep -rn "TO BE CONFIGURED\|your-domain.example" .` returns only
intentional documentation.

---

## 2. Domain, hosting and production server URL — **BLOCKER**

| Item | Current state | Needed |
|---|---|---|
| Public website domain | Not configured | Real domain, TLS certificate |
| API base URL | `http://localhost:8080` default | `https://…` production URL |
| Privacy policy URL | Staged as `website/privacy.html` and `website/terms.html` | Deploy at a stable public URL; fill placeholders first |
| Legal placeholders in web pages | Yellow-highlighted placeholders | Replace via `website/config.js` and the policy text |
| Hosting region | Not configured | Region + subprocessor list for the privacy policy |
| Hosting log retention | Not configured | Concrete retention period |
| International transfer mechanism | Not configured | SCCs / adequacy decision if applicable |
| Database provider | Local MongoDB assumed | Managed MongoDB (Atlas or equivalent) with least-privilege user |
| SMTP provider | Gmail App Password example | Production sender domain with SPF/DKIM/DMARC |
| Website feedback API | `apiBaseUrl: ''` (disabled) | Real API URL, or keep disabled |

The extension now exposes a visible, editable **sync server URL** field, so a
production value does not require a code change. The admin console has the same
(`switch_admin_server` in `localStorage`). The public website has
`apiBaseUrl` in `website/config.js`; when empty, the feedback form refuses to
pretend it sent anything and points at the contact email. Do not ship a build
that silently points at a fabricated domain.

---

## 3. Store listings and browser claims — **BLOCKER for distribution**

| Item | Current honest state |
|---|---|
| Chrome Web Store listing | **Does not exist** |
| Microsoft Edge Add-ons listing | **Does not exist** |
| Firefox / AMO listing | **Does not exist**; Firefox is not supported |
| Brave / Arc / Vivaldi | Chromium-based; load-unpacked only, not separately tested |
| Install path today | Unpacked developer build (`download.html#install-dev`) |

The website and README now say pre-release and Chromium-only. **Do not** add
store badges or "install from store" links until the listings are live and
verified. When they exist, update:

- `website/download.html` status chips and install instructions.
- `website/script.js` browser-detection call-to-action URLs.
- `manifest.json` version, permissions justification, and store metadata.
- `docs/STORE_JUSTIFICATION.md` (store-facing data-handling disclosure).

**Also required by stores:** a privacy policy URL, a data-use disclosure, and
screenshots that match the shipped UI.

---

## 4. Payments and donations — **HIGH**

| Item | Current state |
|---|---|
| UPI VPA | Empty by default in `website/config.js`; the donation card is hidden when blank |
| Donation QR image | Empty; the site shows a "not configured" notice |
| Payment/merchant account | Not configured |
| Refund policy | Generic placeholder in `TERMS_OF_SERVICE.md` |
| Tax/GST details | Not configured |

The remote QR-generation service has been removed. The site only renders a QR
from a **local** image you supply (`donationQrImage` in `website/config.js`).
If you are not ready to accept money, leave `donationUpi` blank and the payment
UI hides itself.

**Why it matters:** publishing a personal VPA or an unowned payment address
creates fraud and chargeback exposure. Use a dedicated merchant account, and
confirm the refund/tax wording with an accountant.

---

## 5. Trademark and branding — **HIGH before marketing spend**

| Item | Status |
|---|---|
| "Switch" name clearance | **Not done** |
| Logo/wordmark ownership | Not documented |
| Domain name ownership | Not documented |
| Third-party browser marks | Descriptive use only; no affiliation claimed |

"Switch" is a common word and may conflict with existing marks in software or
payments. Get a clearance search in your operating jurisdictions before spending
on branding. The terms already disclaim affiliation with Chrome, Edge, Brave,
Firefox, Arc, and Vivaldi.

---

## 6. Privacy and data-protection operations — **BLOCKER / HIGH**

- [ ] **BLOCKER** — Replace every legal placeholder (§1).
- [ ] **BLOCKER** — Publish `website/privacy.html` and `website/terms.html` at a stable public URL after filling placeholders.
- [ ] **HIGH** — Complete a DPIA/records-of-processing entry covering encrypted
      session storage, device metadata, and admin access.
- [ ] **HIGH** — Sign data-processing agreements with the database, email and
      hosting subprocessors.
- [ ] **HIGH** — Decide and document the feedback retention period.
- [ ] **HIGH** — Decide whether EU/UK representation is required.
- [ ] **HIGH** — Document the breach-notification runbook and who owns it.
- [ ] **MEDIUM** — Confirm the children's age threshold for each market.
- [ ] **MEDIUM** — Add a public security disclosure policy (`security.txt` or a
      page) using the configured security email.

---

## 7. Documentation accuracy — **verified, re-check after edits**

The earlier contradictory claims have been corrected:

| File | State |
|---|---|
| `README.md` | Now says pre-release, Chromium-only, no published store listing, manual sync by default. |
| `backend/README.md` | Documents fail-closed production secrets, verified registration, per-user/IP limits, authenticated admin API, erasure/export, and the absence of `devOtp`. |
| `docs/STORE_JUSTIFICATION.md` | Data-handling disclosure now describes optional encrypted sync and minimized metadata. |
| `PRODUCT_OVERVIEW.md` | Chromium-only status, snapshot encryption, and sync behaviour reflect the code. |
| `website/privacy.html`, `website/terms.html` | Public policy pages staged; placeholders must be replaced before publishing. |

Reviewers read the repository, and contradictory privacy claims are a common
rejection reason. After any further documentation change, re-run:

```text
grep -rn "Firefox\|devOtp\|transmits nothing\|figured\|plaintext for v1" README.md PRODUCT_OVERVIEW.md backend/README.md docs/
```

Treat a hit as something to verify, not automatically an error: a statement that
Firefox is *not* supported is correct.

---

## 8. Deployment secrets and operations — **BLOCKER for production**

Production now fails closed. The server will refuse to boot unless these are
set:

| Variable | Requirement |
|---|---|
| `MONGODB_URI` | Required in every environment |
| `TOKEN_SECRET` | ≥ 32 characters in production |
| `REFRESH_PEPPER` | ≥ 16 characters in production |
| `DUMMY_SALT_SECRET` | ≥ 16 characters in production |
| `ALLOWED_ORIGINS` | Required in production; must list the real extension origin(s) |
| `ADMIN_EMAILS` | Optional; **empty disables the entire admin API** |

Generate secrets with a CSPRNG (`openssl rand -base64 48`), store them in a
secret manager, and never commit `.env`.

- [ ] **BLOCKER** — Provision production secrets.
- [ ] **HIGH** — Set `TRUST_PROXY_HOPS` correctly for the load balancer; a wrong
      value lets clients spoof `X-Forwarded-For` and evade rate limits.
- [ ] **HIGH** — Replace the in-memory rate limiter with a shared store before
      running more than one API instance.
- [ ] **HIGH** — Configure database backups and test a restore.
- [ ] **MEDIUM** — Add uptime/error monitoring that does not log request bodies.

---

## 9. Verification still owed — **HIGH**

- [x] Backend smoke + E2E suites pass against a real MongoDB 8.2.6
      (`mongodb-memory-server`, ephemeral). Re-run against the production-like
      instance (auth enabled, backups configured) before launch.
- [ ] Run the extension end-to-end in a real Chromium profile: grant a site,
      save, sign in, explicit push, pull on a second profile, tombstone delete,
      sign-out, account deletion, export.
- [ ] Verify the reinstall path: uninstall without signing out, reinstall, sign
      in, confirm the same-browser prompt appears, and merge so exactly one
      device row remains. Also confirm “Keep separate” leaves both rows and the
      Devices-tab Merge action still works.
- [ ] Verify the admin console against a running server with a real
      `ADMIN_EMAILS` account, including the 403 path when the allowlist is empty
      and the audited `reveal=1` path.
- [ ] Load-test the sync batch endpoint with near-budget payloads.
- [ ] Re-check all HTML after the documentation edits (`node --check` covers JS,
      not markup).

---

## 10. Product decisions — **MEDIUM**

- [ ] Confirm the default sync-server UX: should the field be blank in a store
      build rather than pre-filled with `localhost`?
- [ ] Decide whether legacy accounts at 60,000 PBKDF2 iterations are force-upgraded
      on next successful login (the server stores the count but does not yet
      re-wrap automatically).
- [ ] Decide the fate of the sharing feature: it is implemented server-side but
      not part of the launch UI. Either finish it or hide it consistently.
- [ ] Confirm the feedback destination: feedback is stored in the operator's
      database, not emailed. Someone must actually review it.
- [ ] Decide whether passkey/FIDO2 limitations need a stronger in-product warning.

---

## Quick pre-launch checklist

```text
[ ] Legal entity, address, jurisdiction, contacts, grievance officer filled in
[ ] Public domain + TLS + production API URL
[ ] Privacy policy published at a stable URL
[ ] Production secrets provisioned; server boots with NODE_ENV=production
[ ] ADMIN_EMAILS explicitly set (or intentionally left empty)
[ ] ALLOWED_ORIGINS matches the real extension origin
[ ] MongoDB reachable; smoke + E2E suites pass
[ ] Extension manually tested on Chrome and one other Chromium browser
[x] No store links or "available now" claims without live listings
[x] Donation VPA either configured on a merchant account or hidden
[x] README / backend README / STORE_JUSTIFICATION claims corrected
[ ] Trademark clearance search completed
```
