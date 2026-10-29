# Privacy — Switch (developer summary)

**Last updated:** 28 October 2026

This is the short, technical summary for contributors and reviewers. The
user-facing policy is [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md); if the two
disagree, the user-facing policy controls and this file is the bug.

## What Switch accesses

Switch is a session-bridge extension. It requests access **per origin**, through
the browser's permission prompt:

- **Cookies** for origins you grant, read only when you explicitly save, restore
  or synchronise a session.
- **`localStorage` and comparable web storage** for the same origins, read at the
  same moments by a content script registered for that origin only.

Switch does not request `<all_urls>` at install time, does not read passwords,
form input, page content, or sites you have not granted, and does not use a
hardware fingerprint.

## What Switch stores on your device

- **Session snapshots:** cookies and storage keys for granted sites, stored in
  `chrome.storage.local`.
  - New snapshots are **encrypted at rest** with the vault key and host-bound
    additional authenticated data.
  - Legacy plaintext snapshots are re-sealed the first time they are read.
  - If the vault is locked, reads fail with `vault_locked`; they do not fall back
    to plaintext.
- **Vault key:** in `chrome.storage.session`. It is cleared when the browser
  session ends and on sign-out. It is never written to persistent storage.
- **Consent record:** version, timestamp, data categories and a capped history.
- **Local identifiers:** a random `deviceId`, a random per-profile `systemId`,
  the granted-host list, and UI preferences.

Signing out clears the vault key and local plaintext caches. Account deletion
(separate, explicit, confirmed) removes local snapshots as well.

## What Switch transmits

Nothing is transmitted unless **you** trigger it.

- **Manual sync / explicit push:** uploads encrypted envelopes for the hosts you
  selected. There is no automatic "push everything" after login, registration,
  password reset, or opening the popup.
- **Optional auto-sync:** off by default. When enabled it requires current
  consent, an authenticated session, an unlocked vault, and a granted host. It
  only touches hosts you granted.
- **Account operations:** email verification, sign-in, device registration, and
  feedback you submit.

Uploaded envelopes are AES-256-GCM ciphertext. The server has no key and no
decryption path.

## What the server stores

- Account: email, scrypt-hashed `authHash`, KDF salt and iteration count,
  optional public key, `tokenVersion`.
- Sync: `host`, encrypted `envelope`, `version`, timestamps, tombstone flag,
  random `deviceId`, device label, and the server-side `userId`.
- Devices: random `deviceId`, random `systemId`, human label, coarse
  `browser` / `browserMajorVersion` / `os`, `lastSeenAt`.
- Auth: refresh-token hashes with TTL, OTP hashes with TTL.
- Shares: sender/recipient ids, host, wrapped key, acceptance state.
- Feedback: type, description, optional email. **No IP address, no user-agent.**

The server does **not** store the master password, encryption key, plaintext
cookies, full user-agent string, browsing history, or feedback IP addresses.
IP addresses are processed transiently for rate limiting and are not written to
the application database.

## Admin console

The admin API is authenticated and allowlisted (`ADMIN_EMAILS`). With no
allowlist configured, the entire surface returns 403 instead of falling open.
Emails and device identifiers are masked by default; requesting unmasked values
(`reveal=1`) is recorded in the admin audit log. Admins can never decrypt
session envelopes.

## Retention and deletion

- Refresh tokens and OTPs expire through TTL indexes.
- Synced deletions are tombstones, which carry no payload.
- Reinstalling creates a new random `deviceId`. If you explicitly merge the
  previous install, its encrypted session copies move to the current device and
  the duplicate device record is deleted. Merging never decrypts anything.
- Account deletion removes the account, encrypted sessions, devices, refresh
  tokens, OTPs, recovery keys and shares.
- Feedback is retained until reviewed, then deleted.

## Contact

Privacy: [PRIVACY EMAIL — TO BE CONFIGURED]
Security: [SECURITY EMAIL — TO BE CONFIGURED]
