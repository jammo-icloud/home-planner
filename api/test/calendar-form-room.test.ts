import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// calMount and closeCalOpen are read out of the page and run against a stub of the few things they touch.
const page = readFileSync(new URL('../../site/index.html', import.meta.url), 'utf8');
const code = page.slice(page.indexOf('function calMount('), page.indexOf('/** Escape on the Calendar'));

function setup() {
  const classes = new Set<string>();
  const els: Record<string, any> = {
    calendar: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
    'cal-panel': { replaceChildren() {}, hidden: true },
    'cal-keep': { setAttribute() {} }, 'cal-new': { setAttribute() {} },
  };
  const run = new Function('$', `let calOpen = null, calPanelDay = null;\n${code}\nreturn { calMount, closeCalOpen };`)((id: string) => els[id]);
  return { classes, run };
}

test('an open form adds no room under the page: the Calendar ends where its content ends (0.9.2)', () => {
  const { classes, run } = setup();
  const scrolled: unknown[] = [];
  let focused = false;
  run.calMount(null, { scrollIntoView: (o: unknown) => scrolled.push(o), isConnected: true, replaceWith() {} }, { focus() { focused = true; } });
  assert.deepEqual([...classes], []);
  // The form still comes into view at its top, and its first field takes focus.
  assert.deepEqual(scrolled, [{ block: 'start' }]);
  assert.ok(focused);
  run.closeCalOpen();
  assert.deepEqual([...classes], []);
  assert.doesNotMatch(page, /cal-room/);
  assert.doesNotMatch(page, /#calendar[^{]*\{[^}]*padding-bottom:\s*100v?h/);
});
