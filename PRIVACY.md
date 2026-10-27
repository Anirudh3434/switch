# Privacy Policy — Switch

_Last updated: [DATE]_

## What Switch accesses

Switch is a session-bridge extension. To work, it needs access to:

- **Cookies** for the specific websites you explicitly grant, via the browser's
  own permission prompt.
- **localStorage** for those same websites, read by a content script that runs
  only on origins you have granted.

Switch does **not** request host permissions for all websites at install time.
Access is requested per-origin, when you click "Give access to this site".

## What Switch stores

- Session snapshots (cookies + localStorage) are stored **on your device**, in
  the browser's extension storage.
- Snapshots you export are **encrypted on your device** before they leave it.
  The encryption key is derived from a password only you know.

## What Switch transmits

- **Nothing, in the current version.** There is no Switch server. Export and
  import use a local file that you move between browsers however you like.

## What we can and cannot see

We cannot decrypt your snapshots. If a future version adds cloud sync, the
server stores only ciphertext and account metadata. We will never hold the
encryption key.

## Data retention & deletion

All snapshots live on your device. Deleting a snapshot from the UI removes it
from extension storage immediately.

## Contact

[EMAIL]
