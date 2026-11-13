import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The committed ICO is derived from the existing vector logo. Regeneration uses
// a headless browser already used by the UI test suite; it never starts Mosaic.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'public/favicon.svg'), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const pixels = await page.evaluate(async ({ svg, sizes }) => {
    const image = new Image();
    image.src = 'data:image/svg+xml;base64,' + btoa(svg);
    await image.decode();
    return sizes.map(size => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, size, size);
      return Array.from(context.getImageData(0, 0, size, size).data);
    });
  }, { svg, sizes });
  const images = sizes.map((size, index) => {
    const maskStride = Math.ceil(size / 32) * 4;
    const image = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    image.writeUInt32LE(40, 0);
    image.writeInt32LE(size, 4);
    image.writeInt32LE(size * 2, 8);
    image.writeUInt16LE(1, 12);
    image.writeUInt16LE(32, 14);
    image.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = 40 + ((size - y - 1) * size + x) * 4;
      const rgba = pixels[index];
      image[target] = rgba[source + 2]; image[target + 1] = rgba[source + 1];
      image[target + 2] = rgba[source]; image[target + 3] = rgba[source + 3];
      if (rgba[source + 3] === 0) image[40 + size * size * 4 + (size - y - 1) * maskStride + Math.floor(x / 8)] |= 1 << (7 - x % 8);
    }
    return image;
  });
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (let i = 0; i < sizes.length; i++) {
    const entry = 6 + 16 * i;
    header[entry] = header[entry + 1] = sizes[i] % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  }
  await mkdir(join(root, 'installer'), { recursive: true });
  await writeFile(join(root, 'installer/icon.ico'), Buffer.concat([header, ...images]));
  console.log('installer/icon.ico regenerated from public/favicon.svg');
} finally { await browser.close(); }
