import sharp from '../backend/node_modules/sharp/dist/index.mjs';
import path from 'path';

async function cropUpiLogos() {
  const inputJpg = 'C:/Users/Anirudh Bhardwaj/.gemini/antigravity-ide/brain/ea962a5b-6eb5-4501-92b5-ccbd1bc942b1/upi_apps_icons_1792651845457.jpg';
  const outDir = 'src/assets/upi';

  // 1. Google Pay: approx left: 60, top: 380, width: 160, height: 230
  // 2. PhonePe: approx left: 275, top: 390, width: 215, height: 215
  // 3. Paytm: approx left: 505, top: 450, width: 235, height: 95
  // 4. BHIM: approx left: 765, top: 385, width: 205, height: 230

  const metadata = await sharp(inputJpg).metadata();
  console.log(`Original image: ${metadata.width}x${metadata.height}`);

  // GPay
  await sharp(inputJpg)
    .extract({ left: 60, top: 380, width: 160, height: 235 })
    .toFile(path.join(outDir, 'gpay.png'));

  // PhonePe
  await sharp(inputJpg)
    .extract({ left: 275, top: 395, width: 210, height: 210 })
    .toFile(path.join(outDir, 'phonepe.png'));

  // Paytm
  await sharp(inputJpg)
    .extract({ left: 510, top: 460, width: 235, height: 80 })
    .toFile(path.join(outDir, 'paytm.png'));

  // BHIM
  await sharp(inputJpg)
    .extract({ left: 770, top: 390, width: 200, height: 220 })
    .toFile(path.join(outDir, 'bhim.png'));

  console.log('All 4 UPI logos successfully extracted into src/assets/upi/');
}

cropUpiLogos().catch(console.error);
