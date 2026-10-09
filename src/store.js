/**
 * Persisted settings: caps, whitelists, target folder, schedule.
 *
 * Deliberately separate from credentials. This file holds no secrets -- it is
 * safe to read, copy or show in the GUI -- while cookies stay in
 * `~/.bili-purge/credentials.json` and are never echoed back.
 *
 * It lives in the user's home directory rather than the project so that
 * personal whitelists are never accidentally committed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UNFOLLOW_PRESET, FAVORITE_PRESET } from './config.js';

export const SETTINGS_DIR = path.join(os.homedir(), '.bili-purge');
export const DEFAULT_SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

/** Hard ceilings. The GUI cannot raise a cap past these, whatever is typed. */
export const HARD_LIMITS = {
  unfollowDailyCap: 400,
  favoritesDailyCap: 1000,
  perRun: 200,
  freshCapDays: 3650,
};

export function defaultSettings() {
  return {
    version: 1,
    unfollow: {
      enabled: true,
      dailyCap: UNFOLLOW_PRESET.maxPerDay,
      perRun: UNFOLLOW_PRESET.maxPerRun,
      freshCapDays: 365,
      whitelist: [],
    },
    favorites: {
      enabled: false,
      dailyCap: FAVORITE_PRESET.maxPerDay,
      perRun: FAVORITE_PRESET.maxPerRun,
      freshCapDays: 365,
      folderId: null,
      folderName: '',
      whitelist: [],
    },
    schedule: {
      enabled: false,
      time: '03:30',
    },
  };
}

function clampInt(value, fallback, min, max) {
  // Treat "absent" as absent. Number(null) and Number('') are both 0, which
  // would otherwise be clamped up to the minimum and look like a real choice
  // the user made.
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * A list of identifier strings, de-duplicated, order preserved.
 *
 * One entry may arrive holding several ids. That happens when a UI renders the
 * list into a textarea and reads it back: if the join used a backslash instead
 * of a real newline, the literal sequence backslash+n survives -- it is not
 * whitespace, so splitting on whitespace alone leaves the ids glued together
 * and every one of them silently stops matching.
 */
function idList(value) {
  // An array and a bare string are both meaningful shapes here. A number, a
  // boolean or an object is not a list of ids, and coercing one would invent an
  // id out of "[object Object]".
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const literalNewline = String.fromCharCode(92) + 'n';
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const parts = String(entry ?? '')
      .split(literalNewline)
      .join(String.fromCharCode(10))
      .split(/[\s,;]+/);
    for (const part of parts) {
      const id = part.trim();
      if (id === '' || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** True for a 24-hour HH:MM string. */
export function isValidClock(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value ?? ''));
}

/**
 * Coerce whatever is on disk into a complete, in-range settings object.
 * Unknown keys are dropped rather than carried along.
 */
export function normalizeSettings(raw) {
  const base = defaultSettings();
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unfollow = source.unfollow ?? {};
  const favorites = source.favorites ?? {};
  const schedule = source.schedule ?? {};

  return {
    version: 1,
    unfollow: {
      enabled: unfollow.enabled !== false,
      dailyCap: clampInt(unfollow.dailyCap, base.unfollow.dailyCap, 0, HARD_LIMITS.unfollowDailyCap),
      perRun: clampInt(unfollow.perRun, base.unfollow.perRun, 1, HARD_LIMITS.perRun),
      freshCapDays: clampInt(unfollow.freshCapDays, base.unfollow.freshCapDays, 1, HARD_LIMITS.freshCapDays),
      whitelist: idList(unfollow.whitelist),
    },
    favorites: {
      enabled: favorites.enabled === true,
      dailyCap: clampInt(favorites.dailyCap, base.favorites.dailyCap, 0, HARD_LIMITS.favoritesDailyCap),
      perRun: clampInt(favorites.perRun, base.favorites.perRun, 1, HARD_LIMITS.perRun),
      freshCapDays: clampInt(favorites.freshCapDays, base.favorites.freshCapDays, 1, HARD_LIMITS.freshCapDays),
      folderId: favorites.folderId === null || favorites.folderId === undefined || favorites.folderId === ''
        ? null
        : String(favorites.folderId),
      folderName: typeof favorites.folderName === 'string' ? favorites.folderName : '',
      whitelist: idList(favorites.whitelist),
    },
    schedule: {
      enabled: schedule.enabled === true,
      time: isValidClock(schedule.time) ? String(schedule.time) : base.schedule.time,
    },
  };
}

/** Read settings, falling back to defaults when the file is absent. */
export function loadSettings(file = DEFAULT_SETTINGS_PATH) {
  if (!fs.existsSync(file)) return defaultSettings();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`settings file is not valid JSON: ${file}\n  ${error.message}`);
  }
  return normalizeSettings(parsed);
}

/** Write settings atomically enough that a crash cannot leave half a file. */
export function saveSettings(settings, file = DEFAULT_SETTINGS_PATH) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  return normalized;
}

/**
 * The bucket ladder implied by a settings block.
 * `null` means "no absolute cap", i.e. the pure relative ruler.
 */
export function freshCapFrom(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return null;
  return days;
}
