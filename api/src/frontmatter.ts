// api/src/frontmatter.ts
//
// The block at the top of a page, between `---` fences: a fixed set of keys,
// each a line of `key: value`. It is YAML in the small, the part a person can
// edit by hand, and no more. There is no library behind it on purpose: the keys
// are known (PAGE_KEYS), so the reader is a page of code that the writer is
// tested against.
//
// What is written is what is read back. A string that would read as something
// else (a number, `null`, a list, a comment) is double-quoted on the way out;
// what an editor does by hand (reorders, pads, comments, single quotes) is
// understood on the way in. A line this does not understand is left alone, so
// a key someone added is not an error.

import { PAGE_KEYS, type FrontValue, type PageKind } from './types.ts';

/** Characters a plain value may not start with: they open a quote, a list, a map, a comment, an anchor or a directive. */
const NOT_FIRST = `"'[]{},#&*!|>%@\``;
const SPELLED = new Set(['null', 'true', 'false', '~']);

function needsQuotes(s: string, inList: boolean): boolean {
  return s === '' || s !== s.trim()
    || s.includes(': ') || /\s#/.test(s) || /[\r\n]/.test(s)
    || NOT_FIRST.includes(s[0]!)
    || /^-?\d+$/.test(s) || SPELLED.has(s)
    || (inList && /[,\]]/.test(s));
}

function renderString(s: string, inList: boolean): string {
  return needsQuotes(s, inList) ? JSON.stringify(s) : s;
}

function renderValue(key: string, v: FrontValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error(`frontmatter ${key}: ${v} is not a whole number`);
    return String(v);
  }
  if (typeof v === 'string') return renderString(v, false);
  return `[${v.map((x) => renderString(x, true)).join(', ')}]`;
}

/**
 * The block between `---` fences, keys in `PAGE_KEYS` order, then a blank line.
 * `comments` annotates a key's line (`key: value  # comment`); the reader drops them.
 * Throws on a missing or extra key: a page is never half-described.
 */
export function renderFrontmatter(
  kind: PageKind,
  values: Readonly<Record<string, FrontValue>>,
  comments: Readonly<Record<string, string>> = {},
): string {
  const keys = PAGE_KEYS[kind];
  for (const k of keys) if (!(k in values) || values[k] === undefined) throw new Error(`${kind} frontmatter is missing ${k}`);
  for (const k of Object.keys(values)) if (!keys.includes(k)) throw new Error(`${kind} frontmatter has no key ${k}`);
  const lines = keys.map((k) => {
    const c = comments[k];
    return `${k}: ${renderValue(k, values[k]!)}${c === undefined ? '' : `  # ${c.replace(/\s+/g, ' ').trim()}`}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/**
 * The line without its trailing `# comment`. A `#` starts one when it opens the
 * value or follows a space, and not inside quotes. A quote opens only where a
 * value or a list item starts, so the apostrophe in `it's` is just a letter.
 */
function stripComment(s: string): string {
  let quote = '';
  let itemStart = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (quote === "'" && c === "'" && s[i + 1] === "'") i++;
      else if (c === quote) quote = '';
      continue;
    }
    if ((c === '"' || c === "'") && itemStart) { quote = c; itemStart = false; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i);
    if (c === ' ' || c === '\t') continue;
    itemStart = c === '[' || c === ',';
  }
  return s;
}

/** A quoted or plain string; never a number or null (a list holds text). */
function parseText(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const v: unknown = JSON.parse(s);
      if (typeof v === 'string') return v;
    } catch { /* not JSON after all: read it as written */ }
    return s;
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replaceAll("''", "'");
  return s;
}

/** The items of a list body, split on commas outside quotes. */
function splitItems(inner: string): string[] {
  const items: string[] = [];
  let quote = '';
  let itemStart = true;
  let from = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') i++;
      else if (quote === "'" && c === "'" && inner[i + 1] === "'") i++;
      else if (c === quote) quote = '';
      continue;
    }
    if ((c === '"' || c === "'") && itemStart) { quote = c; itemStart = false; continue; }
    if (c === ',') { items.push(inner.slice(from, i)); from = i + 1; itemStart = true; continue; }
    if (c !== ' ' && c !== '\t') itemStart = false;
  }
  items.push(inner.slice(from));
  return items;
}

function parseValue(raw: string): FrontValue {
  const s = raw.trim();
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s.length >= 2 && s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1);
    return inner.trim() === '' ? [] : splitItems(inner).map(parseText);
  }
  return parseText(s);
}

/**
 * Null when the text does not open with a fence (or never closes one). Keys in
 * any order; `#` comments outside quotes dropped. The body is what follows the
 * closing fence, less the one blank line the writer leaves after it.
 */
export function parseFrontmatter(text: string): { values: Record<string, FrontValue>; body: string } | null {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  const values: Record<string, FrontValue> = {};
  let pos = open[0].length;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end).replace(/\r$/, '');
    pos = nl === -1 ? text.length + 1 : nl + 1;
    if (line.trimEnd() === '---') {
      const rest = pos > text.length ? '' : text.slice(pos);
      return { values, body: rest.replace(/^\r?\n/, '') };
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/.exec(line);
    if (m) values[m[1]!] = parseValue(stripComment(m[2]!));
  }
  return null;
}
