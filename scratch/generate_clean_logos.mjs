import fs from 'fs';
import path from 'path';
import sharp from '../backend/node_modules/sharp/dist/index.mjs';

const upiDir = 'src/assets/upi';
if (!fs.existsSync(upiDir)) {
  fs.mkdirSync(upiDir, { recursive: true });
}

// 1. Google Pay: Official 4-color G
const gpaySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

// 2. PhonePe: Purple squircle + authentic Devanagari 'पे'
const phonepeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="#5f259f"/>
  <!-- Top bar (shirorekha) -->
  <rect x="14" y="24" width="36" height="5" rx="2.5" fill="#ffffff"/>
  <!-- Matra (upper accent slanting up-left towards 23, 11) -->
  <path d="M37.5 24.5 L24.8 11.2 C24 10.3 22.6 10.3 21.7 11.1 C20.8 12 20.8 13.4 21.7 14.3 L33.2 25.5 Z" fill="#ffffff"/>
  <!-- Right vertical full stem -->
  <rect x="35.5" y="24" width="5.5" height="26" rx="2.75" fill="#ffffff"/>
  <!-- Left 'U' loop of 'प' -->
  <path d="M21 24v13c0 4.4 3.6 8 8 8h7v-5.2h-7c-1.5 0-2.8-1.3-2.8-2.8V24H21z" fill="#ffffff"/>
</svg>`;

// 3. Paytm: Clean white rounded badge with official dual-tone typography
const paytmSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 84 32" width="84" height="32">
  <rect width="84" height="32" rx="6" fill="#ffffff"/>
  <g transform="translate(4, 2)">
    <!-- Navy "Pay" -->
    <path fill="#002970" d="M7 6h5.4c3.4 0 5.6 2.1 5.6 5.2s-2.2 5.2-5.6 5.2H9.7v5.8H7V6zm2.7 7.8h2.6c1.9 0 3-1 3-2.6s-1.1-2.6-3-2.6H9.7v5.2z"/>
    <path fill="#002970" d="M27.2 11.6v10.6h-2.5v-1.7c-1 1.3-2.5 2-4.2 2-3.5 0-5.8-2.5-5.8-5.9s2.3-5.9 5.8-5.9c1.6 0 3.2.7 4.2 2v-1.1h2.5zm-2.5 4.9c0-1.9-1.4-3.4-3.4-3.4s-3.4 1.5-3.4 3.4 1.4 3.4 3.4 3.4 3.4-1.5 3.4-3.4z"/>
    <path fill="#002970" d="M29.8 11.6l3.8 9.2 3.6-9.2h2.8l-5.5 13.2c-1.1 2.7-2.7 3.5-5.2 3.5-.8 0-1.6-.2-2.2-.4v-2.4c.4.2 1.1.3 1.6.3 1.4 0 2.2-.5 2.8-2l.3-.6-5.1-11.6h3.1z"/>
    <!-- Cyan "tm" -->
    <path fill="#00baf2" d="M47.2 8.2v3.4h3.8v2.4h-3.8v5.7c0 1 .5 1.4 1.4 1.4.7 0 1.5-.2 2.1-.5v2.4c-.9.4-2 .6-3.1.6-2.5 0-3.4-1.3-3.4-3.6v-6h-2.4v-2.4h2.4v-2.9l2.9-.5z"/>
    <path fill="#00baf2" d="M54.1 11.6v1.7c1.1-1.3 2.6-2 4.3-2 2.2 0 3.8 1.2 4.3 3 1.2-1.8 2.9-3 5.2-3 3.1 0 5.1 2.1 5.1 5.6v7h-2.8v-6.6c0-2.1-1-3.3-2.8-3.3s-2.9 1.2-2.9 3.3v6.6h-2.8v-6.6c0-2.1-1-3.3-2.8-3.3s-2.9 1.2-2.9 3.3v6.6h-2.8V11.6h2.8z"/>
  </g>
</svg>`;

// 4. BHIM / UPI: Official NPCI green & orange dual chevrons emblem
const bhimSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <g transform="translate(6, 4)">
    <!-- NPCI Green Primary Chevron -->
    <polygon points="17,3 27,3 15,37 5,37" fill="#00843d"/>
    <!-- NPCI Orange/Saffron Accent Chevron -->
    <polygon points="29,3 37,3 25,37 17,37" fill="#f47920"/>
  </g>
</svg>`;

async function buildLogos() {
  fs.writeFileSync(path.join(upiDir, 'gpay.svg'), gpaySvg);
  fs.writeFileSync(path.join(upiDir, 'phonepe.svg'), phonepeSvg);
  fs.writeFileSync(path.join(upiDir, 'paytm.svg'), paytmSvg);
  fs.writeFileSync(path.join(upiDir, 'bhim.svg'), bhimSvg);

  await sharp(Buffer.from(gpaySvg), { density: 300 })
    .resize(128, 128)
    .png()
    .toFile(path.join(upiDir, 'gpay.png'));

  await sharp(Buffer.from(phonepeSvg), { density: 300 })
    .resize(128, 128)
    .png()
    .toFile(path.join(upiDir, 'phonepe.png'));

  await sharp(Buffer.from(paytmSvg), { density: 300 })
    .resize(210, 80)
    .png()
    .toFile(path.join(upiDir, 'paytm.png'));

  await sharp(Buffer.from(bhimSvg), { density: 300 })
    .resize(128, 128)
    .png()
    .toFile(path.join(upiDir, 'bhim.png'));

  console.log('All 4 logos generated with vector precision & crisp 32-bit transparency!');
}

buildLogos().catch(console.error);
