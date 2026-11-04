import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crc32, inflateSync } from 'node:zlib';

import { backgroundOf, solidPng } from '../tools/make-icon.ts';

const site = (name: string) => fileURLToPath(new URL(`../../site/${name}`, import.meta.url));
const svg = readFileSync(site('icon.svg'), 'utf8');

describe('the Home Screen icon', () => {
  test("the background is the icon's own blue", () => {
    assert.deepEqual(backgroundOf(svg), [0x0c, 0x8c, 0xe9]);
  });

  test('an SVG with no rect has no background', () => {
    assert.throws(() => backgroundOf('<svg></svg>'));
  });

  test('a solid PNG is signed, sized and filled', () => {
    const png = solidPng(180, [12, 140, 233]);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const chunks: { type: string; data: Buffer }[] = [];
    let at = 8;
    while (at < png.length) {
      const length = png.readUInt32BE(at);
      const type = png.toString('latin1', at + 4, at + 8);
      const data = png.subarray(at + 8, at + 8 + length);
      assert.equal(png.readUInt32BE(at + 8 + length), crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), `${type} CRC`);
      chunks.push({ type, data });
      at += 12 + length;
    }
    assert.equal(chunks[0]?.type, 'IHDR');
    assert.equal(chunks.at(-1)?.type, 'IEND');
    const ihdr = chunks[0]!.data;
    assert.equal(ihdr.readUInt32BE(0), 180);
    assert.equal(ihdr.readUInt32BE(4), 180);
    assert.equal(ihdr[8], 8);
    assert.equal(ihdr[9], 2);

    const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
    assert.equal(raw.length, 180 * (1 + 180 * 3));
    for (let row = 0; row < 180; row++) {
      const start = row * (1 + 180 * 3);
      assert.equal(raw[start], 0);
      for (let x = 0; x < 180; x++) {
        const p = start + 1 + x * 3;
        assert.deepEqual([raw[p], raw[p + 1], raw[p + 2]], [12, 140, 233]);
      }
    }
  });

  test('the committed icon is the one the script makes', () => {
    assert.deepEqual(readFileSync(site('icon-180.png')), solidPng(180, backgroundOf(svg)));
  });
});
