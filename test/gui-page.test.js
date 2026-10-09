import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../gui/index.html', import.meta.url), 'utf8');

/** Pull one top-level `const NAME = ...;` line out of the page's inline script. */
function pageConstant(name) {
  const match = new RegExp(`^const ${name} = (.+);$`, 'm').exec(html);
  assert.ok(match, `gui/index.html should define ${name}`);
  return match[1];
}

test('the whitelist textarea round-trips, so ids are not glued into one entry', () => {
  // The page joined the list with the two-character sequence backslash+n
  // instead of a real newline. The textarea then held both ids on one line, and
  // on save they were stored as a single entry that matched neither id -- which
  // is how two whitelisted accounts got unfollowed.
  const factory = new Function(
    `const idsToLines = ${pageConstant('idsToLines')};`
    + `const linesToIds = ${pageConstant('linesToIds')};`
    + 'return { idsToLines, linesToIds };',
  );
  const { idsToLines, linesToIds } = factory();

  const ids = ['20165629', '1935882'];
  assert.equal(idsToLines(ids), `20165629${String.fromCharCode(10)}1935882`);
  assert.deepEqual(linesToIds(idsToLines(ids)), ids);
});

test('the page paints a background layer behind the panels', () => {
  // The artwork is decor, so it must sit behind everything and never take a
  // click. The panels stay opaque, which is what keeps contrast independent of
  // whichever image is underneath.
  assert.ok(html.includes('<div id="bg"></div>'), 'the artwork layer must exist');
  assert.ok(html.includes('id="bgToggle"'), 'and a control to turn it off');
  assert.ok(html.includes('function applyBackground()'), 'and the code that paints it');
  assert.ok(/position: fixed; inset: 0; z-index: -1; pointer-events: none;/.test(html),
    'the layer must be fixed, behind, and click-through');
});

test('the page contains no doubled-backslash newline escape', () => {
  // The inline script of an HTML file is written literally, so a separator
  // meant to be a newline is easy to emit as two backslashes followed by "n".
  // JavaScript reads that as a literal backslash and an "n", not a newline.
  const doubled = String.fromCharCode(92) + String.fromCharCode(92) + 'n';
  const offenders = html.split(String.fromCharCode(10))
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line.includes(doubled))
    .map(({ line, number }) => `${number}: ${line}`);

  assert.deepEqual(offenders, [],
    'these lines render a literal backslash-n instead of a newline');
});

test('every element the page queries by id is actually in the markup', () => {
  // A typo in a $('...') lookup throws while the page loads, which takes the
  // whole console down rather than failing one button.
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const referenced = [...new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  assert.ok(referenced.length > 10, 'the page should query a fair number of elements');

  const dangling = referenced.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(dangling, [], 'these ids are queried but never defined');
});

test('the background upload lets the user choose the crop themselves', () => {
  // Scaling an upload down automatically was not what was asked for: the user
  // wants to decide the framing. That needs a real control, not a fixed crop.
  assert.ok(html.includes('id="cropModal"'), 'the picker must exist');
  assert.ok(html.includes('id="cropView"'), 'with a surface to drag');
  assert.ok(html.includes('id="cropZoom"'), 'a zoom control');
  assert.ok(html.includes('id="cropApply"'), 'a way to accept the framing');
  assert.ok(html.includes('id="cropCancel"'), 'and a way out');

  // The frame the user frames against must have the same shape as the file that
  // gets saved, or the picker would misrepresent the finished background.
  const frame = /id="cropView" width="(\d+)" height="(\d+)"/.exec(html);
  assert.ok(frame, 'the frame should declare its backing store');
  assert.equal(Number(frame[1]) / Number(frame[2]), 16 / 9, 'the frame should be 16:9');

  const width = /out\.width = (\d+);/.exec(html);
  const height = /out\.height = (\d+);/.exec(html);
  assert.ok(width && height, 'the saved image size should be explicit');
  assert.equal(Number(width[1]) / Number(height[1]), 16 / 9, 'and should match the frame');
});
