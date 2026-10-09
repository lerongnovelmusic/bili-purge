/**
 * Daily quota tracking, derived from the audit logs.
 *
 * Deliberately stateless: the count for a day is recomputed by reading the
 * JSONL logs rather than kept in a counter file, so it can never drift out of
 * sync with what actually happened, and a crashed run cannot lose its tally.
 *
 * The day boundary is the operator's LOCAL date, not UTC. A run at 01:00
 * local time is "today" to the person running it, even though the UTC date
 * still says yesterday.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Every log record in a directory, oldest file first. Unparseable lines are skipped. */
export function readActionLogs(logDir = 'logs') {
  if (!fs.existsSync(logDir)) return [];

  const files = fs.readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();

  const records = [];
  for (const name of files) {
    const text = fs.readFileSync(path.join(logDir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A truncated final line from an interrupted run is expected.
      }
    }
  }
  return records;
}

/** Successful actions of one kind recorded on a given local date. */
export function usedOn(logDir, dateKey, { action = 'unfollow' } = {}) {
  return readActionLogs(logDir).filter((record) => {
    if (record.action !== action || record.ok !== true || !record.ts) return false;
    const when = new Date(record.ts);
    if (Number.isNaN(when.getTime())) return false;
    return localDateKey(when) === dateKey;
  }).length;
}

/** A short usage report, newest day first. */
export function usageByDay(logDir, { action = 'unfollow', days = 7, now = new Date() } = {}) {
  const counts = new Map();
  for (const record of readActionLogs(logDir)) {
    if (record.action !== action || record.ok !== true || !record.ts) continue;
    const when = new Date(record.ts);
    if (Number.isNaN(when.getTime())) continue;
    const key = localDateKey(when);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const today = localDateKey(now);
  const series = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const key = localDateKey(date);
    series.push({ date: key, count: counts.get(key) ?? 0, today: key === today });
  }
  return series;
}
