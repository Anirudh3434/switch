// Onboarding / disclosure flow.
//
// This page is the single source of truth for what the user is told. The popup
// only points here — it never carries its own copy of the disclosure, so the
// two can never drift apart.
//
// Deliberately NOT a fake of Chrome's own permission dialog. Faking the
// browser's UI would be the most deceptive option available and is grounds for
// removal. We disclose; the browser still asks.

import { giveConsent, isStaleConsent, CONSENT_VERSION } from '../lib/consent.js';

const $ = (id) => document.getElementById(id);
let step = 1;
const TOTAL = 4;

function show(n) {
  step = n;
  document.querySelectorAll('.step').forEach((s) => {
    s.classList.toggle('hidden', Number(s.dataset.step) !== n);
  });
  document.querySelectorAll('.bar').forEach((b, i) => {
    b.classList.toggle('on', i < n);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.querySelectorAll('[data-next]').forEach((b) =>
  b.addEventListener('click', () => show(Math.min(step + 1, TOTAL))),
);
document.querySelectorAll('[data-back]').forEach((b) =>
  b.addEventListener('click', () => show(Math.max(step - 1, 1))),
);

// Both checkboxes must be ticked — "affirmative and informed".
function syncAccept() {
  $('accept').disabled = !($('agree').checked && $('privacy').checked);
}
$('agree').addEventListener('change', syncAccept);
$('privacy').addEventListener('change', syncAccept);

$('privacyLink').addEventListener('click', async (e) => {
  e.preventDefault();
  // A rendered page, not PRIVACY.md — Chrome downloads .md files instead of
  // displaying them, which looks broken.
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/privacy.html') });
});

$('accept').addEventListener('click', async () => {
  await giveConsent();

  // Do NOT open popup.html as a tab. The popup is a 340px panel that reads the
  // *active* tab; opened as a normal tab it only ever sees itself and reports
  // "Open a website first". Tell the user to click the toolbar icon instead.
  document.querySelector('[data-step="4"]').innerHTML = `
    <h2>You're all set</h2>
    <p>
      Switch won't read anything until you grant it access to a specific site.
    </p>
    <p class="muted">
      Click the <strong>Switch icon in your browser toolbar</strong> on any site
      you're logged into, then choose <em>Give access to this site</em>. Switch
      will capture that site's session straight away.
    </p>
    <div class="nav"><button class="primary" id="done">Close this tab</button></div>
  `;
  $('done').addEventListener('click', () => window.close());
});

$('decline').addEventListener('click', () => {
  document.querySelector('[data-step="4"]').innerHTML = `
    <h2>No problem</h2>
    <p>
      Switch hasn't been given consent, so it won't read any of your data and
      won't run. You can close this tab.
    </p>
    <p class="muted">
      If you change your mind, click the Switch icon in your toolbar and choose
      <em>Review what Switch accesses</em>.
    </p>
    <div class="nav"><button class="ghost" id="close">Close tab</button></div>
  `;
  $('close').addEventListener('click', () => window.close());
});

// If consent was already given under older wording, say so plainly.
if (await isStaleConsent()) {
  document.querySelector('[data-step="1"] p.muted').textContent =
    'Switch updated what it tells you about data access. Please review the ' +
    'changes and confirm again — your existing saved sessions are untouched.';
}
