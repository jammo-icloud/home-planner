// Makes the app's icons from site/icon.svg: the PNGs a phone, a tab and the web
// manifest keep, and the favicon.ico Safari asks for. The repository has no image
// tooling, so the SVG is drawn by whatever renderer this machine already has:
// rsvg-convert when it is on PATH, otherwise Quick Look's qlmanage, which every
// Mac ships. The PNGs are committed, so a machine with neither never needs to run
// this; the renderer is not byte-stable across machines, which is why the tests
// read the committed pictures rather than compare them with a fresh render.
//
// decodePng exists so a test can look at the pixels without an image library, and
// icoOf wraps PNGs as they are, which every browser since Vista reads.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG of the SVG at size×size, from rsvg-convert when found, else qlmanage. */
export async function render(svgPath: string, size: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'make-icon-'));
  try {
    try {
      const out = join(dir, 'rsvg.png');
      await run('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, svgPath]);
      return await readFile(out);
    } catch {
      // Not installed, or it failed: fall through to Quick Look.
    }
    try {
      // qlmanage names its output <input file name>.png.
      await run('qlmanage', ['-t', '-s', String(size), '-o', dir, svgPath]);
      return await readFile(join(dir, `${basename(svgPath)}.png`));
    } catch {
      throw new Error('could not render the SVG: neither rsvg-convert nor qlmanage worked here');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The pixels of an 8-bit RGB or RGBA, non-interlaced PNG; throws on anything else. */
export function decodePng(png: Buffer): { width: number; height: number; channels: 3 | 4; pixels: Uint8Array } {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels: 3 | 4 = 3;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit PNGs are read');
      if (data[9] === 2) channels = 3;
      else if (data[9] === 6) channels = 4;
      else throw new Error('only RGB and RGBA PNGs are read');
      if (data[12] !== 0) throw new Error('interlaced PNGs are not read');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('the PNG has no IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (1 + stride)) throw new Error('the PNG data is the wrong length');

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)]!;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (1 + stride) + 1 + i]!;
      const left = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      pixels[y * stride + i] = (x + predicted) & 255;
    }
  }
  return { width, height, channels, pixels };
}

/** An ICO whose entries are the given PNGs as they are; each size comes from its IHDR. */
export function icoOf(pngs: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const at = 6 + 16 * i;
    header[at] = width >= 256 ? 0 : width; // 0 means 256
    header[at + 1] = height >= 256 ? 0 : height;
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const svg = fileURLToPath(new URL('../../site/icon.svg', import.meta.url));
  const out = (name: string) => fileURLToPath(new URL(`../../site/${name}`, import.meta.url));
  const png: Record<number, Buffer> = {};
  for (const size of [16, 32, 180, 192, 512]) png[size] = await render(svg, size);
  for (const size of [32, 180, 192, 512]) {
    await writeFile(out(`icon-${size}.png`), png[size]!);
    console.log(`${out(`icon-${size}.png`)}: ${png[size]!.length} bytes`);
  }
  const ico = icoOf([png[16]!, png[32]!]);
  await writeFile(out('favicon.ico'), ico);
  console.log(`${out('favicon.ico')}: ${ico.length} bytes`);
}
