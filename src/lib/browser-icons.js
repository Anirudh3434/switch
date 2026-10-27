// CSS-cropped sprite icons and vector fallbacks for major web browsers.
// Maps Chrome, Edge, Firefox, Safari, Brave, Opera, Arc, Vivaldi, Tor to the 3x3 sprite sheet.

export function getBrowserSpriteClass(browserName) {
  const b = String(browserName || '').toLowerCase().trim();

  // Row 1: Chrome (0% 0%), Edge (50% 0%), Firefox (100% 0%)
  if (b.includes('edge') || b.includes('edg')) return 'browser-edge';
  if (b.includes('firefox')) return 'browser-firefox';

  // Row 2: Safari (0% 50%), Brave (50% 50%), Opera (100% 50%)
  if (b.includes('safari')) return 'browser-safari';
  if (b.includes('brave')) return 'browser-brave';
  if (b.includes('opera') || b.includes('opr')) return 'browser-opera';

  // Row 3: Arc (0% 100%), Vivaldi (50% 100%), Tor (100% 100%)
  if (b.includes('arc')) return 'browser-arc';
  if (b.includes('vivaldi')) return 'browser-vivaldi';
  if (b.includes('tor')) return 'browser-tor';

  // Chrome / Chromium (Row 1 Col 1)
  if (b.includes('chrome') || b.includes('chromium')) return 'browser-chrome';

  // Default fallback
  return 'browser-chrome';
}

export function getBrowserDisplayName(browserName) {
  const b = String(browserName || '').toLowerCase().trim();
  if (b.includes('edge') || b.includes('edg')) return 'Microsoft Edge';
  if (b.includes('firefox')) return 'Mozilla Firefox';
  if (b.includes('safari')) return 'Apple Safari';
  if (b.includes('brave')) return 'Brave Browser';
  if (b.includes('opera') || b.includes('opr')) return 'Opera';
  if (b.includes('arc')) return 'Arc';
  if (b.includes('vivaldi')) return 'Vivaldi';
  if (b.includes('tor')) return 'Tor Browser';
  if (b.includes('chrome') || b.includes('chromium')) return 'Google Chrome';
  return browserName || 'Web Browser';
}

/**
 * Returns HTML markup for a CSS-cropped browser icon from browsers-sprite.jpg.
 * @param {string} browserName - e.g. "Chrome", "Edge", "Firefox", "Safari", etc.
 * @param {Object} options - { sizeClass: 'size-sm' | 'size-md' | 'size-lg', extraClass: string, label: string }
 */
export function getBrowserSpriteHtml(browserName, options = {}) {
  const spriteClass = getBrowserSpriteClass(browserName);
  const sizeClass = options.sizeClass || 'size-md';
  const extraClass = options.extraClass ? ` ${options.extraClass}` : '';
  const label = options.label || getBrowserDisplayName(browserName);

  return `<span class="browser-sprite-icon ${spriteClass} ${sizeClass}${extraClass}" role="img" aria-label="${label}" title="${label}"></span>`;
}

/**
 * Backward-compatible function: renders the CSS-cropped sprite markup for the browser.
 */
export function getBrowserLogoSvg(browserName, size = 22) {
  const sizeClass = size <= 18 ? 'size-sm' : size >= 26 ? 'size-lg' : 'size-md';
  return getBrowserSpriteHtml(browserName, { sizeClass });
}
