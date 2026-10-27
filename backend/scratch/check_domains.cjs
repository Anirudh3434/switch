const fs = require('fs');
const path = require('path');

const chromeExt = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Default', 'Local Extension Settings', 'mihlehcaooajconnalpdphociooifmcd');
const buf = fs.readFileSync(path.join(chromeExt, '000003.log'));
const str = buf.toString('latin1');
const matches = str.match(/"domain":"([^"]+)"/g);
if (matches) {
  const domains = [...new Set(matches.map(m => m.replace('"domain":"', '').replace('"', '')))];
  console.log('Total unique domains found in log:', domains.length);
  const invalid = [];
  const validHost = (h) => typeof h === 'string' && h.length > 0 && h.length <= 253 && /^[a-z0-9.-]+$/i.test(h);
  for (const d of domains) {
    const clean = d.replace(/^\./, '').toLowerCase().trim();
    if (!validHost(clean)) {
      invalid.push({ raw: d, clean });
    }
  }
  console.log('Invalid hosts for backend regex:', invalid);
}
