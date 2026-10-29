# Chrome Web Store submission — permission justification

Chrome rejects extensions that request permissions they don't need. This is
the text to put in the single-purpose + permission fields. Keep it factual;
reviewers check it against your actual behaviour.

## Single purpose description

> Switch lets a user save the login state (cookies and local storage) of a
> website they are currently logged into, and restore that state in another
> browser on the same or another machine. It does one thing: move a user's own
> login session between their own browsers, at their explicit request.

## Requested permissions and why

**`cookies`**
Required to read the cookies of a website the user is logged into and to write
them back when the user clicks "Restore". Cookies are the only API that can
read and write `HttpOnly` session cookies.

**`storage`**
Stores session snapshots and extension settings locally on the user's device.

**`scripting`**
Reads and writes `localStorage` for a specific origin. There is no other API
that can do this — `localStorage` is only reachable from a content script
running inside that origin.

**`tabs`**
Reads the current tab's URL so the extension knows which site the user wants to
save or restore. Nothing else.

**`activeTab`**
Reads the active tab when the user invokes the extension.

**Optional host permissions (`https://*/*`, `http://*/*`) — requested at
runtime, not at install**
Switch does **not** request host access at install time. When the user clicks
"Give access to this site", the browser's own permission prompt appears for
that single origin. Switch only ever accesses origins the user has explicitly
granted, and the user can revoke access at any time from the browser's
extension settings.

## Data handling (required disclosure)

- Session snapshots are stored locally in extension storage, encrypted at rest
  with a key derived from the user's master password.
- Sync is **optional and manual by default**. Nothing is uploaded just because
  the user signs in. If the user chooses to sync, only AES-256-GCM ciphertext
  plus routing metadata (host, version, timestamps, random device id, coarse
  device label) is sent to the configured server. The server never receives the
  password, the encryption key, or plaintext cookies.
- Optional auto-sync is **off by default**. When enabled it requires current
  consent, an authenticated session, an unlocked vault and a granted origin, and
  it only touches origins the user granted.
- Exported files are encrypted client-side before leaving the device. The
  developer has no access to the key.
- Feedback submitted through the website stores the message, type and optional
  email. It does not store the submitter's IP address or user-agent.

## Single-purpose compliance notes

- No remote code is executed. All logic ships inside the package.
- No `eval`, no `new Function`, no dynamically-injected scripts.
- No click-to-search, no ads, no affiliate redirects.
- The extension does exactly what the listing says, with no hidden behaviour.

---

## Anticipated reviewer objections and honest answers

**"This could be used to steal cookies."**
It only reads cookies for origins the user has granted through the browser's
own prompt, and only when the user clicks Save, Restore or an explicit sync
action, or has deliberately enabled auto-sync for that granted origin. It cannot
silently harvest all browsing: there is no `<all_urls>` host permission at
install. Auto-sync is off by default and requires consent, an unlocked vault and
a per-origin grant.

**"This facilitates login-restriction circumvention."**
Malicious-and-prohibited #4 prohibits facilitating *unauthorized* access. The
user is moving their *own* active session on sites they are *already logged
into*, with no bypass of paywalls, MFA or access controls. Sites that
device-bind sessions still reject the relocated session. Document this in the
listing so it isn't oversold.

**"Why optional permissions instead of broad host access?"**
Because the policy requires the narrowest permissions that implement the
feature. Per-origin grants are strictly narrower, are visible to the user, and
are revocable.
