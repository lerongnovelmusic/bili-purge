import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url));

test('start.cmd stays pure ASCII, so cmd cannot mis-parse it', () => {
  // cmd reads a batch file using the OEM code page, not UTF-8. Chinese text in
  // there made cmd skip whole lines -- including the ones that start the
  // server -- while still reaching the final `pause`, so double-clicking just
  // showed "Press any key to continue" and nothing happened.
  const bytes = read('start.cmd');
  const nonAscii = [...bytes].filter((byte) => byte > 0x7f);
  assert.equal(nonAscii.length, 0,
    'every human-readable message belongs in tools/launch.mjs, not in the .cmd');
});

test('start.cmd delegates to the Node launcher', () => {
  const cmd = read('start.cmd').toString('utf8');
  assert.ok(cmd.includes('tools\\launch.mjs'), 'the batch file should hand off to Node');

  const launcher = fs.readFileSync(new URL('../tools/launch.mjs', import.meta.url), 'utf8');
  assert.ok(launcher.includes("'gui.js'"), 'and the launcher should start the console');
  assert.ok(launcher.includes("'--open'"), 'and ask it to open a browser');
});

test('make-shortcut.ps1 keeps its UTF-8 BOM', () => {
  // Windows PowerShell 5.1 reads a script without a BOM as ANSI. The Chinese
  // default shortcut name then mangles the parser and the script refuses to
  // run at all with a confusing "Missing ')' in function parameter list".
  const bytes = read('tools/make-shortcut.ps1');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM is load-bearing');
  assert.ok(bytes.toString('utf8').includes("'B站清理助手'"),
    'and the default name should survive as real UTF-8');
});

test('the console can fall back to the next port instead of dying', () => {
  // Double-clicking the launcher twice is normal; the second click used to fail
  // with EADDRINUSE and the window closed. An explicit --port is still honoured.
  const gui = fs.readFileSync(new URL('../gui.js', import.meta.url), 'utf8');
  assert.ok(gui.includes('function listenFrom('), 'there should be a port-walking listen');
  assert.ok(/portArg \? 0 : 10/.test(gui),
    'walk forward only when the port was not asked for explicitly');
  assert.ok(gui.includes("args.includes('--open')"), 'and --open should be opt-in');
});
