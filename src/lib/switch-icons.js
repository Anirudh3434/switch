// Switch Custom 16-Icon Sprite Pack Generator & Helper
// Maps the 4x4 uniform sprite sheet for Light & Dark mode.

export const SWITCH_ICONS = {
  // Row 1: Security & Storage
  SHIELD: 'switch-icon-shield',       // (0,0) Security Shield & Consent
  LOCK: 'switch-icon-lock',           // (1,0) Zero-Knowledge Vault Padlock
  KEY: 'switch-icon-key',             // (2,0) Cryptographic Auth Token Key
  DATABASE: 'switch-icon-database',   // (3,0) Cookie Storage Stack

  // Row 2: Synchronization & Actions
  CLOUD: 'switch-icon-cloud',         // (0,1) Cloud Vault Upload
  REFRESH: 'switch-icon-refresh',     // (1,1) Circular Refresh Loop
  INSPECT: 'switch-icon-inspect',     // (2,1) DevTools Inspector Window
  COPY: 'switch-icon-copy',           // (3,1) Clipboard Dual Sheets Copy

  // Row 3: Navigation & Filtering
  SEARCH: 'switch-icon-search',       // (0,2) Search Magnifying Glass
  CLOCK: 'switch-icon-clock',         // (1,2) Session Expiry Clock
  DEVICE: 'switch-icon-device',       // (2,2) Laptop Hardware Device
  CHEVRONS: 'switch-icon-chevrons',   // (3,2) Expand/Collapse Accordion

  // Row 4: Controls & Theme
  SUN: 'switch-icon-sun',             // (0,3) Radiant Sun (Light Mode)
  MOON: 'switch-icon-moon',           // (1,3) Crescent Moon (Dark Mode)
  TRASH: 'switch-icon-trash',         // (2,3) Delete / Purge Trash Bin
  LOGOUT: 'switch-icon-logout',       // (3,3) Door Sign Out
};

/**
 * Generates HTML markup for a Switch custom sprite icon.
 * Automatically adapts between Light and Dark mode via CSS variables.
 * @param {string} iconName - key in SWITCH_ICONS or suffix (e.g. 'shield', 'lock', 'search')
 * @param {Object} options - { sizeClass: 'size-xs'|'size-sm'|'size-md'|'size-lg'|'size-xl', extraClass: '', label: '' }
 */
export function getSwitchIconHtml(iconName, options = {}) {
  const key = String(iconName).toUpperCase().trim();
  const iconClass = SWITCH_ICONS[key] || `switch-icon-${String(iconName).toLowerCase()}`;
  const sizeClass = options.sizeClass || 'size-md';
  const extraClass = options.extraClass ? ` ${options.extraClass}` : '';
  const label = options.label || iconName || '';
  return `<span class="switch-icon ${iconClass} ${sizeClass}${extraClass}" role="img" aria-label="${label}" title="${label}"></span>`;
}
