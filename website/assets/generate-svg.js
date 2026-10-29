import fs from 'fs';

// Mathematical representation of the Session Bridge logo
// Grid: 512 x 512. Center: (256, 256).
// Left Node: (120, 256), Right Node: (392, 256)
// Connecting Bridge Ribbon forming a continuous infinity-switch bridge

const svg = `<svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Solid Vibrant Gradient from Electric Cyan to Violet -->
    <linearGradient id="switch-bridge-grad" x1="60" y1="256" x2="452" y2="256" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="28%" stop-color="#0ea5e9"/>
      <stop offset="68%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>

    <!-- Subtle ambient glow for the nodes -->
    <filter id="node-glow-cyan" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="0" stdDeviation="16" flood-color="#00f2fe" flood-opacity="0.45"/>
    </filter>
    <filter id="node-glow-purple" x="-50%" y="-50%" width="200%" height="200%">
      <feDropShadow dx="0" dy="0" stdDeviation="16" flood-color="#a855f7" flood-opacity="0.45"/>
    </filter>
    <filter id="tile-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="12" stdDeviation="24" flood-color="#000000" flood-opacity="0.5"/>
    </filter>
  </defs>

  <!-- App Icon Squircle Background -->
  <rect x="16" y="16" width="480" height="480" rx="112" fill="#0c1017" filter="url(#tile-shadow)"/>
  <rect x="16" y="16" width="480" height="480" rx="112" stroke="rgba(255, 255, 255, 0.08)" stroke-width="2"/>

  <!-- Left Session Node (Browser A) -->
  <circle cx="120" cy="256" r="48" fill="#00f2fe" filter="url(#node-glow-cyan)"/>

  <!-- Right Session Node (Browser B) -->
  <circle cx="392" cy="256" r="48" fill="#a855f7" filter="url(#node-glow-purple)"/>

  <!-- Symmetrical 2D Solid Session Bridge Loop -->
  <!-- Upper loop sweeps from Left Node up through center, Right loop sweeps around Right Node -->
  <path d="M 120 256 C 120 186 174 156 230 156 C 266 156 292 176 316 206 L 196 306 C 220 336 246 356 282 356 C 338 356 392 326 392 256" 
        stroke="url(#switch-bridge-grad)" 
        stroke-width="52" 
        stroke-linecap="round" 
        stroke-linejoin="round"/>

  <!-- Core Bridge Diagonal Crossover -->
  <path d="M 200 302 L 312 210" 
        stroke="url(#switch-bridge-grad)" 
        stroke-width="56" 
        stroke-linecap="round"/>
</svg>`;

fs.writeFileSync('src/assets/logo.svg', svg);
console.log('src/assets/logo.svg written successfully!');
