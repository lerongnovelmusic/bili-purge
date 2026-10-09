/**
 * Reading back what previous runs did.
 *
 * Everything here is derived from files on disk, so the GUI and the daily
 * runner show the same truth as the command line.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LOG_DIR = 'logs';
export const SNAPSHOT_DIR = 'snapshots';

/** Newest snapshot whose filename starts with `prefix`, or null. */
export function newestSnapshot(prefix, dir = SNAPSHOT_DIR) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

/** Every log file, newest first. */
export function logFiles(dir = LOG_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => path.join(dir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * One entry per run, newest first, built from each log's header and summary.
 * Unreadable or truncated files are skipped rather than throwing.
 */
export function readHistory(dir = LOG_DIR, limit = 10) {
  const out = [];

  for (const file of logFiles(dir)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let header = null;
    let summary = null;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.kind === 'header') header = parsed;
      else if (parsed.kind === 'summary') summary = parsed;
    }

    if (!header) continue;
    out.push({
      file,
      action: header.action ?? 'unfollow',
      source: header.source ?? 'cli',
      startedAt: header.ts ?? null,
      planned: header.planned ?? null,
      mediaId: header.mediaId ?? null,
      folderTitle: header.folderTitle ?? null,
      ok: summary?.ok ?? null,
      failed: summary?.failed ?? null,
      aborted: summary?.aborted ?? false,
      finished: summary !== null,
    });

    if (out.length >= limit) break;
  }

  return out;
}

/** True when a run is already logged for the given local date. */
export function ranOnLocalDate(dateKey, dir = LOG_DIR) {
  return readHistory(dir, 1000).some((entry) => {
    if (!entry.startedAt) return false;
    const when = new Date(entry.startedAt);
    if (Number.isNaN(when.getTime())) return false;
    const year = when.getFullYear();
    const month = String(when.getMonth() + 1).padStart(2, '0');
    const day = String(when.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}` === dateKey;
  });
}
