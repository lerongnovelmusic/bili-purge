import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsvLine, dailyTaskStatus, TASK_NAME } from '../src/scheduler.js';

test('a plain CSV row splits on commas', () => {
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
});

test('quoted fields keep their commas', () => {
  assert.deepEqual(parseCsvLine('"a,b",c'), ['a,b', 'c']);
});

test('doubled quotes become one quote', () => {
  assert.deepEqual(parseCsvLine('"he said ""hi""",x'), ['he said "hi"', 'x']);
});

test('empty fields survive, because column position carries the meaning', () => {
  assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);
  assert.deepEqual(parseCsvLine(',,'), ['', '', '']);
  assert.equal(parseCsvLine('a,b,').length, 3);
});

test('a realistic schtasks row keeps its columns aligned', () => {
  // Trimmed from real `schtasks /FO CSV /V` output.
  const row = '"DESKTOP-1","\\BiliPurgeDaily","2026/10/9 3:30:00","就绪","只使用交互式",'
    + '"1999/11/30 0:00:00","267011","DESKTOP-1\\user","cmd","N/A","N/A","已启用","已禁用",'
    + '"按需模式停止","user","已禁用","72:00:00","plan","每天","3:30:00"';
  const fields = parseCsvLine(row);

  assert.equal(fields.length, 20);
  assert.equal(fields[2], '2026/10/9 3:30:00');
  assert.equal(fields[3], '就绪');
  assert.equal(fields[6], '267011');
  assert.equal(fields[14], 'user');
  assert.equal(fields[19], '3:30:00');
});

test('a trailing newline does not create a phantom column', () => {
  assert.deepEqual(parseCsvLine('a,b\r'), ['a', 'b\r']);
  assert.deepEqual(parseCsvLine('a,b'), ['a', 'b']);
});

test('an unclosed quote does not hang or throw', () => {
  assert.deepEqual(parseCsvLine('"unterminated'), ['unterminated']);
});

test('dailyTaskStatus reports "not installed" instead of throwing', () => {
  // Whatever this machine's state, the call must return a shape the GUI can
  // render without a try/catch of its own.
  const status = dailyTaskStatus();
  assert.equal(typeof status.installed, 'boolean');
  assert.equal(status.taskName, TASK_NAME);
  if (status.installed) {
    // Null is the honest answer for "schtasks printed N/A".
    assert.ok(status.nextRunTime === null || typeof status.nextRunTime === 'string');
  }
});

test('the task name is a fixed, recognisable identifier', () => {
  assert.equal(TASK_NAME, 'BiliPurgeDaily');
});
