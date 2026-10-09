import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { localDateKey, readActionLogs, usedOn, usageByDay } from '../src/quota.js';

const DEFAULT_LOG_NAME = 'unfollow-2026-10-08T10-00-00.jsonl';

/** Accepts a raw string, an array of lines, or a { filename: content } map. */
function tempLogDir(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-purge-quota-'));
  if (typeof content === 'string') {
    fs.writeFileSync(path.join(dir, DEFAULT_LOG_NAME), content, 'utf8');
  } else if (Array.isArray(content)) {
    fs.writeFileSync(path.join(dir, DEFAULT_LOG_NAME), content.join('\n'), 'utf8');
  } else if (content) {
    for (const [name, text] of Object.entries(content)) {
      fs.writeFileSync(path.join(dir, name), text, 'utf8');
    }
  }
  return dir;
}

/** An ISO timestamp for a given local wall-clock time. */
const localIso = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour).toISOString();

test('localDateKey formats the local date, not the UTC one', () => {
  assert.equal(localDateKey(new Date(2026, 9, 8, 0, 30)), '2026-10-08');
  assert.match(localDateKey(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});

test('usedOn counts only successful actions of that kind on that day', () => {
  const dir = tempLogDir([
    JSON.stringify({ action: 'unfollow', mid: 1, ok: true, ts: localIso(2026, 10, 8, 9) }),
    JSON.stringify({ action: 'unfollow', mid: 2, ok: true, ts: localIso(2026, 10, 8, 18) }),
    JSON.stringify({ action: 'unfollow', mid: 3, ok: false, ts: localIso(2026, 10, 8, 19) }),
    JSON.stringify({ action: 'unfollow', mid: 4, ok: true, ts: localIso(2026, 10, 7, 9) }),
    JSON.stringify({ kind: 'header', ts: localIso(2026, 10, 8, 8) }),
    JSON.stringify({ kind: 'summary', ok: 2, failed: 1 }),
  ]);

  assert.equal(usedOn(dir, '2026-10-08'), 2);
  assert.equal(usedOn(dir, '2026-10-07'), 1);
  assert.equal(usedOn(dir, '2026-10-06'), 0);
});

test('the day boundary follows local time, not UTC', () => {
  // 00:30 local on the 8th is still the 7th in UTC for UTC+8. Attributing it to
  // the UTC day would hand the operator a fresh quota mid-session.
  const dir = tempLogDir([
    JSON.stringify({ action: 'unfollow', mid: 1, ok: true, ts: localIso(2026, 10, 8, 0) }),
  ]);
  assert.equal(usedOn(dir, '2026-10-08'), 1);
  assert.equal(usedOn(dir, '2026-10-07'), 0);
});

test('a different action does not consume the unfollow quota', () => {
  const dir = tempLogDir([
    JSON.stringify({ action: 'favorites', id: 1, ok: true, ts: localIso(2026, 10, 8) }),
  ]);
  assert.equal(usedOn(dir, '2026-10-08'), 0);
  assert.equal(usedOn(dir, '2026-10-08', { action: 'favorites' }), 1);
});

test('records are pooled across every log file in the directory', () => {
  const dir = tempLogDir({
    'unfollow-a.jsonl': `${JSON.stringify({ action: 'unfollow', mid: 1, ok: true, ts: localIso(2026, 10, 8, 8) })}\n`,
    'unfollow-b.jsonl': `${JSON.stringify({ action: 'unfollow', mid: 2, ok: true, ts: localIso(2026, 10, 8, 20) })}\n`,
  });
  assert.equal(usedOn(dir, '2026-10-08'), 2);
});

test('a truncated final line from an interrupted run is skipped, not fatal', () => {
  const dir = tempLogDir(
    `${JSON.stringify({ action: 'unfollow', mid: 1, ok: true, ts: localIso(2026, 10, 8) })}\n{"action":"unfol`,
  );
  assert.equal(readActionLogs(dir).length, 1);
  assert.equal(usedOn(dir, '2026-10-08'), 1);
});

test('a record with an unparseable timestamp is ignored', () => {
  const dir = tempLogDir([
    JSON.stringify({ action: 'unfollow', mid: 1, ok: true, ts: 'garbage' }),
  ]);
  assert.equal(usedOn(dir, '2026-10-08'), 0);
});

test('a missing log directory is empty, not an error', () => {
  const missing = path.join(os.tmpdir(), 'bili-purge-does-not-exist-xyz');
  assert.deepEqual(readActionLogs(missing), []);
  assert.equal(usedOn(missing, '2026-10-08'), 0);
});

test('usageByDay returns today first and marks it', () => {
  const now = new Date(2026, 9, 8, 15);
  const dir = tempLogDir([
    JSON.stringify({ action: 'unfollow', mid: 1, ok: true, ts: localIso(2026, 10, 8, 9) }),
    JSON.stringify({ action: 'unfollow', mid: 2, ok: true, ts: localIso(2026, 10, 7, 9) }),
    JSON.stringify({ action: 'unfollow', mid: 3, ok: true, ts: localIso(2026, 10, 7, 10) }),
  ]);

  const series = usageByDay(dir, { days: 3, now });
  assert.equal(series.length, 3);
  assert.deepEqual(series[0], { date: '2026-10-08', count: 1, today: true });
  assert.deepEqual(series[1], { date: '2026-10-07', count: 2, today: false });
  assert.deepEqual(series[2], { date: '2026-10-06', count: 0, today: false });
});
