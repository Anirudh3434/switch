# Privacy Policy for Switch

**Last updated:** 28 October 2026
**Policy version:** 2026-10-28

> **Operator notice — fill this in before publishing.**
> This document uses bracketed placeholders for facts only the operator can
> supply: the legal entity, contact addresses, hosting region and grievance
> officer. Publishing a privacy policy with placeholder legal details is not
> acceptable. See `LAUNCH_BLOCKERS.md`.

## 1. Who is responsible for your data

Switch is a browser extension and an optional self-hostable sync service.

- **Data controller:** [LEGAL ENTITY NAME — TO BE CONFIGURED]
- **Registered address:** [REGISTERED ADDRESS — TO BE CONFIGURED]
- **Privacy contact:** [PRIVACY EMAIL — TO BE CONFIGURED]
- **Security contact:** [SECURITY EMAIL — TO BE CONFIGURED]
- **EU/UK representative (if required):** [REPRESENTATIVE — TO BE CONFIGURED]

If you run your own Switch server, **you** are the controller for the data on
that server. The project maintainers do not operate your deployment and cannot
access it.

## 2. The short version

- Switch reads the login state only of websites **you explicitly grant**.
- Your session data is encrypted **on your device** before it is stored or
  uploaded. We do not hold your encryption key and cannot decrypt it.
- Sync is **manual by default**. Nothing is uploaded just because you signed in.
- Optional auto-sync is **off by default**, limited to sites you granted, and
  requires your vault to be unlocked.
- We do not sell your data, run advertising analytics, or build a browsing
  profile.
- You can export or permanently delete your account from the extension.

## 3. What Switch accesses on your device

Switch requests host access **per site**, through your browser's own permission
prompt. It does not request access to all websites at install time.

When you explicitly save or restore a session for a granted site, Switch may
read:

- **Cookies** for that site (including HttpOnly cookies, which the extension is
  permitted to read for granted origins).
- **`localStorage` and comparable web storage** for that site.
- **Session tokens** stored inside those cookies or storage entries.

Switch also reads, locally:

- The site's hostname, so it can label the session and bind encryption to it.
- Coarse browser and operating-system information (for example "Chrome 141 on
  Windows 10/11") used as a human-readable device label.

Switch does **not** read:

- Passwords you type.
- Form contents, keystrokes, screenshots, or page text.
- Sites you have not granted.
- Your full browsing history.
- Other browser profiles or other installed extensions.

## 4. What is stored, and where

### 4.1 On your device

- **Session snapshots:** cookies and storage captured for granted sites. These
  are stored in the extension's local storage and are **encrypted at rest**
  with a key derived from your master password (see §5).
- **Vault key:** held in `chrome.storage.session`, which is cleared when the
  browser session ends. It is not written to persistent storage.
- **Consent record:** the consent version, timestamp and data categories you
  acknowledged, plus a short history so the acknowledgement can be audited.
- **Local settings and identifiers:** a random `deviceId`, a random per-profile
  `systemId`, granted-host list, and UI preferences.

Signing out clears the vault key and local plaintext caches. It does **not**
delete your local snapshots unless you ask it to; deleting the account does.

### 4.2 On the sync server (only if you choose to use it)

| Data | Why it exists |
|---|---|
| Email address | Account identifier and sign-in |
| `authHash` (scrypt-hashed at rest) | Password-equivalent verifier; we never receive your password |
| KDF salt and iteration count | So your device can derive the same keys |
| Optional public key | Enables encrypted session sharing with another account |
| Encrypted session envelopes | Ciphertext of your captured sessions |
| Host, version, timestamps, tombstone flags | Sync ordering, conflict detection and deletion propagation |
| Random `deviceId` and `systemId` | Grouping your own devices; **not** a hardware fingerprint |
| Device label and coarse browser/OS/major version | Lets you recognise your own devices |
| Refresh-token hashes and expiry | Session continuity and revocation |
| OTP hashes and expiry | Email verification and password reset |
| Shared-session records | Who sent what to whom, and acceptance state |
| Feedback you submit | Bug reports and suggestions, with an optional email |

The server does **not** store your master password, your encryption key, your
plaintext cookies, your user-agent string, your IP address in the application
database, or your browsing history.

### 4.3 Transient technical data

The server processes your IP address in memory to apply rate limits and block
abuse. Application code does not write it to the database. Our hosting and
network providers may keep short-lived access logs that include IP addresses
for security and operations; retention there is governed by the hosting
configuration. [HOSTING PROVIDER AND LOG RETENTION — TO BE CONFIGURED]

## 5. How encryption works

- Your master password is processed locally with PBKDF2-SHA-256 to derive
  separate authentication and encryption material.
- New accounts use **600,000 iterations**; the iteration count is stored per
  account so older accounts with lower counts can still sign in and be
  upgraded over time.
- Session data is encrypted with **AES-256-GCM**. The ciphertext is bound to its
  hostname using authenticated additional data, so a server cannot silently
  move one site's session onto another site.
- The server stores ciphertext only. There is no decryption path on the server.
  If you lose your master password, your encrypted sessions cannot be recovered
  — this is a deliberate consequence of zero-knowledge design, not an oversight.

## 6. Why we process data (legal bases)

Where the GDPR or UK GDPR applies, we rely on:

- **Contract** — to provide the extension and sync service you asked for.
- **Consent** — for reading site data and for uploading it. You give this
  per-site and can withdraw it. Withdrawal deletes saved snapshots and revokes
  host access.
- **Legitimate interests** — keeping the service secure, preventing abuse, and
  fixing defects. We limit this to what is necessary and do not use it for
  advertising.
- **Legal obligation** — where we must retain or disclose something by law.

Where India's Digital Personal Data Protection Act (DPDP Act) applies, we
process personal data on the basis of your consent and for the limited
"legitimate uses" permitted by that Act. You may withdraw consent at any time.

## 7. Sharing and third parties

We do not sell personal data. We do not share it for cross-context behavioural
advertising. We share only with service providers needed to run the service:

- **Database hosting** for encrypted envelopes and account records.
- **Email delivery (SMTP)** for verification and password-reset messages. The
  email provider sees your address and the message content.
- **Infrastructure/hosting** for the API.
- **Authorised operators** of the deployment, who can see account metadata and
  masked identifiers. Unmasking an email or device identifier is logged. Even
  an operator cannot decrypt session envelopes.

We may disclose data if required by law, but we can only disclose what we hold:
ciphertext and metadata, not your sessions.

[HOSTING PROVIDERS, REGIONS AND SUBPROCESSOR LIST — TO BE CONFIGURED]

## 8. International transfers

If you use a hosted deployment, your data may be processed outside your
country. Where required, transfers rely on an adequacy decision or standard
contractual clauses. [TRANSFER MECHANISM AND DESTINATION COUNTRIES — TO BE
CONFIGURED]

Self-hosted deployments keep data wherever the operator runs them.

## 9. Retention

- **Account and sync data:** retained until you delete your account or the
  operator removes it. Deleted-session records become tombstones so deletions
  propagate to your other devices; tombstones contain no session payload.
- **Refresh tokens and OTPs:** expire automatically through database TTL
  indexes.
- **Reinstalled devices:** reinstalling creates a new random device identifier.
  If you explicitly merge the previous install, its encrypted session copies are
  reassigned to the current device and the duplicate device registration is
  deleted. Merging never decrypts session contents.
- **Feedback:** retained until reviewed and then deleted, or for a maximum of
  [RETENTION PERIOD — TO BE CONFIGURED].
- **Hosting logs:** retained per the hosting configuration in §4.3.

Account deletion is immediate and irreversible. It removes the account record,
encrypted session copies, device registrations, refresh tokens, OTPs, recovery
keys and shares. Backups may retain encrypted copies for a limited period
before rotation; they contain no plaintext sessions.

## 10. Security

We use TLS for transport, AES-256-GCM for session data, scrypt for stored
authentication verifiers, short-lived access tokens, rotating refresh tokens,
per-account storage budgets, and rate limiting. The extension stores the vault
key in session storage and re-seals legacy plaintext snapshots on read.

No system is perfectly secure. Report a suspected vulnerability to
[SECURITY EMAIL — TO BE CONFIGURED] rather than opening a public issue with
exploit details.

## 11. Your rights

Depending on where you live, you may have the right to:

- **Access** — obtain a copy of your personal data.
- **Portability** — export your data. The extension has a built-in export that
  returns account, device, session-envelope and share metadata as JSON.
- **Correction** — fix inaccurate account information.
- **Erasure** — delete your account and associated data.
- **Restriction / objection** — limit or object to certain processing.
- **Withdraw consent** — at any time, without affecting prior lawful processing.
- **Lodge a complaint** — with your local supervisory authority.

Use the in-extension controls for export and deletion, or contact
[PRIVACY EMAIL — TO BE CONFIGURED]. We may need to verify that you control the
account before acting on a request.

### India — grievance officer (DPDP Act)

- **Grievance Officer:** [NAME — TO BE CONFIGURED]
- **Email:** [GRIEVANCE EMAIL — TO BE CONFIGURED]
- **Response target:** [RESPONSE WINDOW — TO BE CONFIGURED]

You may escalate an unresolved grievance to the Data Protection Board of India.

## 12. Children

Switch is not directed to children under 13 (or the minimum age of digital
consent in your jurisdiction, which may be higher). We do not knowingly collect
data from children. If you believe a child created an account, contact us and
we will delete it.

## 13. Automated decisions and advertising

We do not make automated decisions that produce legal or similarly significant
effects about you. We do not run advertising or cross-site tracking analytics.

## 14. Changes to this policy

We will update the version and date when this policy changes materially. If the
change affects how we handle your data, the extension will ask you to review and
accept the new disclosure before continuing. Historic consent records are kept
so you can see which version you accepted and when.

## 15. Contact

Questions, requests and complaints:
[PRIVACY EMAIL — TO BE CONFIGURED]

Security reports:
[SECURITY EMAIL — TO BE CONFIGURED]
