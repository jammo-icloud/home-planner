// api/test/plist.ts
//
// A reader for the XML property lists the profile writes, small enough to
// trust: recursive descent over a tag regex, no DOM. It understands only what
// the profile uses and throws on anything else, so a test fails loudly when
// the writer drifts.

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parsePlist(xml: string): unknown {
  const body = /<plist[^>]*>([\s\S]*)<\/plist>/.exec(xml)?.[1];
  if (body === undefined) throw new Error('no <plist> element');
  const tokens = [...body.matchAll(/<(\/?)([a-z]+)\s*(\/?)>([^<]*)/g)]
    .map(m => ({ close: m[1] === '/', name: m[2]!, self: m[3] === '/', text: m[4]! }));
  let at = 0;
  const next = () => {
    const t = tokens[at++];
    if (!t) throw new Error('unexpected end of plist');
    return t;
  };
  const text = (name: string, first: string): string => {
    const end = next();
    if (!end.close || end.name !== name) throw new Error(`unbalanced <${name}>`);
    return unescapeXml(first);
  };
  const value = (): unknown => {
    const t = next();
    if (t.close) throw new Error(`unexpected </${t.name}>`);
    switch (t.name) {
      case 'true': return true;
      case 'false': return false;
      case 'string': return t.self ? '' : text('string', t.text);
      case 'integer': return Number(text('integer', t.text));
      case 'data': return Buffer.from(text('data', t.text).replace(/\s+/g, ''), 'base64');
      case 'array': {
        const out: unknown[] = [];
        while (!(tokens[at]?.close)) out.push(value());
        if (next().name !== 'array') throw new Error('unbalanced <array>');
        return out;
      }
      case 'dict': {
        const out: Record<string, unknown> = {};
        while (!(tokens[at]?.close)) {
          const k = next();
          if (k.name !== 'key' || k.close) throw new Error('expected <key>');
          out[text('key', k.text)] = value();
        }
        if (next().name !== 'dict') throw new Error('unbalanced <dict>');
        return out;
      }
      default: throw new Error(`unsupported <${t.name}>`);
    }
  };
  const result = value();
  if (at !== tokens.length) throw new Error('trailing content in plist');
  return result;
}
