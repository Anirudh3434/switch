import sharp from '../backend/node_modules/sharp/dist/index.mjs';
import fs from 'fs';
import path from 'path';

async function processSprite() {
  const inputJpg = 'src/assets/browsers-sprite.jpg';
  const outputPng = 'src/assets/browsers-sprite.png';

  console.log('Loading sprite image:', inputJpg);
  const image = sharp(inputJpg);
  const metadata = await image.metadata();
  console.log(`Image size: ${metadata.width}x${metadata.height}`);

  const { data, info } = await image
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  
  // Dark background keying:
  // Corners are around RGB(20, 20, 20)
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];

    // Distance to dark background (~18, 18, 18)
    const dist = Math.sqrt((r - 18) ** 2 + (g - 18) ** 2 + (b - 18) ** 2);

    if (dist < 14) {
      data[idx + 3] = 0; // Pure transparent background
    } else if (dist < 32) {
      const alphaFraction = (dist - 14) / (32 - 14);
      data[idx + 3] = Math.round(alphaFraction * 255);
    }
  }

  await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toFile(outputPng);

  console.log('Successfully saved high-resolution transparent PNG to:', outputPng);
}

processSprite().catch((err) => {
  console.error('Error processing sprite:', err);
  process.exit(1);
});
