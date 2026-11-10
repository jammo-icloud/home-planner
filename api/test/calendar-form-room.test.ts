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
const form = () => ({ scrollIntoView() {}, isConnected: true, replaceWith() {} });

test('an open form keeps a screen of room under it, and closing gives it back', () => {
  const { classes, run } = setup();
  run.calMount(null, form(), { focus() {} });
  assert.ok(classes.has('cal-room'));
  run.closeCalOpen();
  assert.ok(!classes.has('cal-room'));
  assert.match(page, /#calendar\.cal-room\{padding-bottom:100vh\}/);
});
