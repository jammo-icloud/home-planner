import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { decodePng, icoOf } from '../tools/make-icon.ts';

const site = (name: string) => fileURLToPath(new URL(`../../site/${name}`, import.meta.url));
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/** A PNG from already-filtered scanlines, so a test can choose each row's filter. */
function pngOf(width: number, height: number, colorType: 2 | 3 | 6, filtered: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(filtered)), chunk('IEND', Buffer.alloc(0))]);
}

describe('the icon files', () => {
  test('each committed PNG is the size its name says and is a picture, not a square of one colour', () => {
    for (const n of [32, 180, 192, 512]) {
      const { width, height, channels, pixels } = decodePng(readFileSync(site(`icon-${n}.png`)));
      assert.equal(width, n, `icon-${n} width`);
      assert.equal(height, n, `icon-${n} height`);
      const at = (x: number, y: number) => pixels.subarray((y * width + x) * channels, (y * width + x) * channels + channels);
      for (const [x, y] of [[0, 0], [n - 1, 0], [0, n - 1], [n - 1, n - 1]] as const) {
        const p = at(x, y);
        for (const [i, want] of [12, 140, 233].entries()) {
          assert.ok(Math.abs(p[i]! - want) <= 3, `icon-${n} corner (${x},${y}) channel ${i} is ${p[i]}`);
        }
        if (channels === 4) assert.equal(p[3], 255, `icon-${n} corner (${x},${y}) is opaque`);
      }
      let white = false;
      for (let y = Math.floor(n / 3); y < Math.ceil((2 * n) / 3) && !white; y++) {
        for (let x = Math.floor(n / 3); x < Math.ceil((2 * n) / 3); x++) {
          const p = at(x, y);
          if (p[0]! >= 235 && p[1]! >= 235 && p[2]! >= 235) {
            white = true;
            break;
          }
        }
      }
      assert.ok(white, `icon-${n} has white in its middle third`);
    }
  });

  test('favicon.ico holds the 16 and 32 pixel PNGs', () => {
    const ico = readFileSync(site('favicon.ico'));
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    for (const [entry, size] of [16, 32].entries()) {
      const at = 6 + entry * 16;
      const length = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      const payload = ico.subarray(offset, offset + length);
      assert.deepEqual([...payload.subarray(0, 8)], [...SIGNATURE]);
      const decoded = decodePng(payload);
      assert.equal(decoded.width, size);
      assert.equal(decoded.height, size);
    }
  });
});

describe('decodePng', () => {
  test('undoes the Sub and Up filters', () => {
    // A 3×2 RGB picture. Row 0 is filtered Sub and row 1 Up, so the decoder
    // has to carry the left neighbour and the row above.
    const row0 = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    const row1 = [15, 25, 35, 45, 55, 65, 75, 85, 95];
    const sub0 = row0.map((v, i) => (i < 3 ? v : (v - row0[i - 3]!) & 255));
    const up1 = row1.map((v, i) => (v - row0[i]!) & 255);
    const decoded = decodePng(pngOf(3, 2, 2, Buffer.from([1, ...sub0, 2, ...up1])));
    assert.equal(decoded.channels, 3);
    assert.deepEqual([...decoded.pixels], [...row0, ...row1]);
  });

  test('undoes Average and Paeth as well, on RGBA', () => {
    const row0 = [200, 10, 10, 255, 100, 50, 20, 255];
    const row1 = [190, 30, 12, 255, 120, 40, 25, 255];
    const row2 = [180, 35, 15, 255, 130, 45, 30, 255];
    const avg1 = row1.map((v, i) => (v - (((i < 4 ? 0 : row1[i - 4]!) + row0[i]!) >> 1)) & 255);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const paeth2 = row2.map((v, i) => (v - paeth(i < 4 ? 0 : row2[i - 4]!, row1[i]!, i < 4 ? 0 : row1[i - 4]!)) & 255);
    const decoded = decodePng(pngOf(2, 3, 6, Buffer.from([0, ...row0, 3, ...avg1, 4, ...paeth2])));
    assert.equal(decoded.channels, 4);
    assert.deepEqual([...decoded.pixels], [...row0, ...row1, ...row2]);
  });

  test('refuses what it does not read', () => {
    assert.throws(() => decodePng(Buffer.from('not a png')));
    assert.throws(() => decodePng(pngOf(1, 1, 3, Buffer.from([0, 0]))));
  });
});

describe('icoOf', () => {
  test('reads each entry size from the PNG itself', () => {
    const png = (n: number) => pngOf(n, n, 2, Buffer.alloc(n * (1 + n * 3)));
    const ico = icoOf([png(16), png(32)]);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico[6], 16);
    assert.equal(ico[7], 16);
    assert.equal(ico[6 + 16], 32);
    assert.equal(ico[7 + 16], 32);
    const offset = ico.readUInt32LE(6 + 16 + 12);
    assert.deepEqual([...ico.subarray(offset, offset + 8)], [...SIGNATURE]);
  });
});
