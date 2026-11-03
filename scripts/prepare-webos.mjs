// scripts/prepare-webos.mjs
// Prepares the webos-dist/ folder for LG webOS TV packaging (.ipk)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');
const webosDistDir = path.join(rootDir, 'webos-dist');
const webosSourceDir = path.join(rootDir, 'webos');

if (!fs.existsSync(distDir)) {
  console.error('❌ dist/ directory not found. Please run "npm run build" first.');
  process.exit(1);
}

// 1. Clean and create webos-dist
if (fs.existsSync(webosDistDir)) {
  fs.rmSync(webosDistDir, { recursive: true, force: true });
}
fs.mkdirSync(webosDistDir, { recursive: true });

// 2. Copy dist content to webos-dist
console.log('📦 Copying web build assets to webos-dist...');
fs.cpSync(distDir, webosDistDir, { recursive: true });

// 3. Copy appinfo.json
console.log('📄 Copying appinfo.json...');
fs.copyFileSync(
  path.join(webosSourceDir, 'appinfo.json'),
  path.join(webosDistDir, 'appinfo.json')
);

// 4. Generate standard webOS icons & splash (pure Node.js PNG generator with pixel rendering)
function makePng(width, height, getPixel) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type);
    const combined = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    let c = 0xffffffff;
    const table = [];
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = (v & 1) ? (0xedb88320 ^ (v >>> 1)) : (v >>> 1);
      table[n] = v;
    }
    for (let i = 0; i < combined.length; i++) c = table[(c ^ combined[i]) & 0xff] ^ (c >>> 8);
    crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, combined, crc]);
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = makeChunk('IHDR', ihdrData);

  const rowSize = 1 + width * 4;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(rowSize);
    row[0] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y, width, height);
      const idx = 1 + x * 4;
      row[idx] = r;
      row[idx + 1] = g;
      row[idx + 2] = b;
      row[idx + 3] = a;
    }
    rows.push(row);
  }
  const idat = makeChunk('IDAT', zlib.deflateSync(Buffer.concat(rows)));
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Distance to rounded rectangle
function sdRoundRect(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x) - halfW + radius;
  const dy = Math.abs(y) - halfH + radius;
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ax * ax + ay * ay) - radius;
}

// Render icon (80x80 or 130x130) with StreamUp badge and play glyph
function renderStreamUpIcon(width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const badgeRadius = width * 0.24;
  const badgeHalf = width * 0.42;

  return makePng(width, height, (x, y) => {
    const px = x - cx;
    const py = y - cy;

    // Check distance to rounded badge
    const d = sdRoundRect(px, py, badgeHalf, badgeHalf, badgeRadius);

    if (d <= 0) {
      // Inside badge: check play glyph (triangle pointing right)
      // Triangle vertices: (-half*0.35, -half*0.5) to (-half*0.35, half*0.5) to (half*0.55, 0)
      const tx = px + badgeHalf * 0.08; // slightly shifted right for optical balance
      const ty = py;
      const leftX = -badgeHalf * 0.28;
      const rightX = badgeHalf * 0.45;
      const topSlope = (badgeHalf * 0.42) / (rightX - leftX);

      if (tx >= leftX && tx <= rightX) {
        const maxY = (rightX - tx) * topSlope;
        if (Math.abs(ty) <= maxY) {
          return [255, 255, 255, 255]; // Crisp white play icon
        }
      }

      // Badge gradient: amber (#f59e0b) to rose/crimson (#ef4444)
      const t = (px + badgeHalf) / (badgeHalf * 2);
      const r = Math.round(245 * (1 - t) + 239 * t);
      const g = Math.round(158 * (1 - t) + 68 * t);
      const b = Math.round(11 * (1 - t) + 68 * t);

      // Subtle gold border
      if (d > -2.0) {
        return [251, 191, 36, 255];
      }

      return [r, g, b, 255];
    }

    // Outer background: dark obsidian
    return [12, 13, 20, 255];
  });
}

// Render 1920x1080 Splash screen
function renderStreamUpSplash(width = 1920, height = 1080) {
  const cx = width / 2;
  const cy = height / 2 - 30; // slightly above center
  const badgeHalf = 110;
  const badgeRadius = 32;

  return makePng(width, height, (x, y) => {
    const px = x - cx;
    const py = y - cy;

    const d = sdRoundRect(px, py, badgeHalf, badgeHalf, badgeRadius);

    if (d <= 0) {
      // Play glyph inside badge
      const tx = px + 12;
      const ty = py;
      const leftX = -45;
      const rightX = 65;
      const topSlope = 62 / (rightX - leftX);

      if (tx >= leftX && tx <= rightX && Math.abs(ty) <= (rightX - tx) * topSlope) {
        return [255, 255, 255, 255];
      }

      // Badge gradient
      const t = (px + badgeHalf) / (badgeHalf * 2);
      const r = Math.round(245 * (1 - t) + 239 * t);
      const g = Math.round(158 * (1 - t) + 68 * t);
      const b = Math.round(11 * (1 - t) + 68 * t);

      if (d > -2.5) {
        return [251, 191, 36, 255];
      }

      return [r, g, b, 255];
    }

    // Glow around badge
    const distToCenter = Math.sqrt(px * px + py * py);
    if (distToCenter < 260) {
      const glow = (1 - distToCenter / 260) * 0.28;
      const gr = Math.round(8 + glow * 245);
      const gg = Math.round(9 + glow * 158);
      const gb = Math.round(13 + glow * 11);
      return [gr, gg, gb, 255];
    }

    // Deep cinema dark background (#08090d)
    return [8, 9, 13, 255];
  });
}

// Write webOS required images
const icon80 = renderStreamUpIcon(80, 80);
const icon130 = renderStreamUpIcon(130, 130);
const splash = renderStreamUpSplash(1920, 1080);

fs.writeFileSync(path.join(webosDistDir, 'icon80.png'), icon80);
fs.writeFileSync(path.join(webosDistDir, 'icon130.png'), icon130);
fs.writeFileSync(path.join(webosDistDir, 'splash.png'), splash);

// Also persist into webos/ source directory
fs.writeFileSync(path.join(webosSourceDir, 'icon80.png'), icon80);
fs.writeFileSync(path.join(webosSourceDir, 'icon130.png'), icon130);
fs.writeFileSync(path.join(webosSourceDir, 'splash.png'), splash);

console.log('🎨 Generated vibrant StreamUp brand icons:');
console.log('   - icon80.png  (80x80 App Tile)');
console.log('   - icon130.png (130x130 High-Res Launcher Icon)');
console.log('   - splash.png  (1920x1080 Cinema Launch Screen)');

console.log('✅ webOS app directory prepared at webos-dist/');
console.log('👉 To build the .ipk file:');
console.log('   npm run webos:pack');
