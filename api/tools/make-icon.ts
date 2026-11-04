// Makes site/icon-180.png, the picture a phone keeps when the planner is put on
// its Home Screen. The repository has no image tooling, so the PNG is written
// by hand: a signature, three chunks, and one colour.
//
// The icon is deliberately a flat square of the icon's own blue, without the
// envelope. Home Screen icons are masked by the phone anyway, and a plain
// square never looks wrong. A real rendering of icon.svg can replace the file
// later without any change to this code, as long as it stays 180 by 180.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

/** The fill of the first <rect> in an SVG, as [r, g, b]; throws when there is none. */
export function backgroundOf(svg: string): [number, number, number] {
  const rect = /<rect\b[^>]*>/.exec(svg)?.[0];
  const hex = rect === undefined ? undefined : /\bfill="#([0-9a-fA-F]{6})"/.exec(rect)?.[1];
  if (hex === undefined) throw new Error('the SVG has no <rect> with a six-digit hex fill');
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A size×size PNG of one colour: 8-bit RGB, no interlace, every row filter 0. */
export function solidPng(size: number, rgb: readonly [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let row = 0; row < size; row++) {
    for (let x = 0; x < size; x++) Buffer.from(rgb).copy(raw, row * stride + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const svg = readFileSync(new URL('../../site/icon.svg', import.meta.url), 'utf8');
  const target = new URL('../../site/icon-180.png', import.meta.url);
  const png = solidPng(180, backgroundOf(svg));
  writeFileSync(target, png);
  console.log(`${fileURLToPath(target)}: ${png.length} bytes`);
}
