'use strict';

/**
 * Перерисовывает иконки приложения из build/icon.svg и build/icon-small.svg.
 * Нужен Playwright с Chromium:  node scripts/build-icons.js
 * Результат: build/icon.png, build/icon.ico, src/assets/icon.png, src/assets/icon.ico
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const big = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');
const small = fs.readFileSync(path.join(root, 'build', 'icon-small.svg'), 'utf8');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

/** ICO с PNG-кадрами (поддерживается начиная с Windows Vista). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const images = [];
  for (const size of SIZES) {
    const svg = size <= 32 ? small : big;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace(
        '<svg ',
        `<svg width="${size}" height="${size}" style="display:block" `,
      )}</body></html>`,
    );
    const png = await page.screenshot({ omitBackground: true, type: 'png' });
    images.push({ size, png });
  }
  await browser.close();

  const ico = buildIco(images);
  const png256 = images.find((i) => i.size === 256).png;
  for (const dir of ['build', path.join('src', 'assets')]) {
    fs.writeFileSync(path.join(root, dir, 'icon.ico'), ico);
    fs.writeFileSync(path.join(root, dir, 'icon.png'), png256);
  }
  console.log(`Готово: ${SIZES.join(', ')} px`);
})();
