import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defaultSettings, normalizeSettings, loadSettings, saveSettings,
  isValidClock, HARD_LIMITS,
} from '../src/store.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-store-'));
  return path.join(dir, 'settings.json');
}

test('defaults come back when the file does not exist', () => {
  const missing = path.join(os.tmpdir(), 'bili-store-does-not-exist', 'settings.json');
  const settings = loadSettings(missing);
  assert.deepEqual(settings, defaultSettings());
});

test('defaults leave favourites off, because deleting is the riskier action', () => {
  const settings = defaultSettings();
  assert.equal(settings.unfollow.enabled, true);
  assert.equal(settings.favorites.enabled, false);
  assert.equal(settings.schedule.enabled, false);
});

test('round trip preserves what was saved', () => {
  const file = tempFile();
  const saved = saveSettings({
    unfollow: { dailyCap: 120, perRun: 25, freshCapDays: 500, whitelist: ['1', '2'] },
    favorites: { enabled: true, folderId: '60971020', folderName: '默认收藏夹', whitelist: ['9'] },
    schedule: { enabled: true, time: '04:15' },
  }, file);

  assert.deepEqual(loadSettings(file), saved);
});

test('settings are written as readable JSON', () => {
  const file = tempFile();
  saveSettings({ unfollow: { whitelist: ['20165629'] } }, file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /\n {2}"unfollow"/, 'pretty-printed');
  assert.match(text, /20165629/);
});

test('a corrupt file is reported rather than silently replaced', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  assert.throws(() => loadSettings(file), /not valid JSON/);
});

test('out-of-range numbers are clamped, not rejected', () => {
  const settings = normalizeSettings({
    unfollow: { dailyCap: 99999, perRun: 0, freshCapDays: -5 },
    favorites: { dailyCap: -1 },
  });
  assert.equal(settings.unfollow.dailyCap, HARD_LIMITS.unfollowDailyCap);
  assert.equal(settings.favorites.dailyCap, 0, 'zero is a legal cap meaning "do nothing"');
  assert.equal(settings.unfollow.perRun, 1, 'a per-run budget below 1 is meaningless');
  assert.equal(settings.unfollow.freshCapDays, 1);
});

test('non-numeric garbage falls back to the default', () => {
  const settings = normalizeSettings({
    unfollow: { dailyCap: 'lots', perRun: null, freshCapDays: {} },
  });
  const base = defaultSettings();
  assert.equal(settings.unfollow.dailyCap, base.unfollow.dailyCap);
  assert.equal(settings.unfollow.perRun, base.unfollow.perRun);
  assert.equal(settings.unfollow.freshCapDays, base.unfollow.freshCapDays);
});

test('fractional values are rounded to whole actions', () => {
  assert.equal(normalizeSettings({ unfollow: { perRun: 12.7 } }).unfollow.perRun, 13);
  assert.equal(normalizeSettings({ unfollow: { perRun: 12.2 } }).unfollow.perRun, 12);
});

test('whitelists are trimmed and de-duplicated, order preserved', () => {
  const settings = normalizeSettings({
    unfollow: { whitelist: [' 20165629 ', '1935882', '20165629', '', '  ', 123] },
  });
  assert.deepEqual(settings.unfollow.whitelist, ['20165629', '1935882', '123']);
});

test('ids glued together by a literal backslash-n are split apart', () => {
  // This is the bug that unfollowed two whitelisted accounts. The GUI joined
  // the list with the two-character sequence backslash+n instead of a real
  // newline, so the single entry held both ids. Backslash+n is not whitespace,
  // so nothing matched and neither account was protected.
  const glued = '20165629' + String.fromCharCode(92) + 'n1935882';
  assert.deepEqual(
    normalizeSettings({ unfollow: { whitelist: [glued] } }).unfollow.whitelist,
    ['20165629', '1935882'],
  );
});

test('a whitelist blob splits on newlines, commas, semicolons and spaces', () => {
  const blob = '1,2 3;4' + String.fromCharCode(10) + '5';
  assert.deepEqual(
    normalizeSettings({ unfollow: { whitelist: [blob] } }).unfollow.whitelist,
    ['1', '2', '3', '4', '5'],
  );
});

test('a whitelist given as a bare string is honoured, not silently dropped', () => {
  // Dropping it yields an empty whitelist, i.e. LESS protection than the file
  // asked for -- the failure direction that actually deletes things. Coercing
  // is the fail-safe reading.
  assert.deepEqual(
    normalizeSettings({ unfollow: { whitelist: '20165629' } }).unfollow.whitelist,
    ['20165629'],
  );
  assert.deepEqual(
    normalizeSettings({ favorites: { whitelist: 'BV1xx411c7mD' } }).favorites.whitelist,
    ['BV1xx411c7mD'],
  );
});

test('a whitelist that cannot be ids becomes empty rather than throwing', () => {
  for (const bad of [null, 42, {}, true]) {
    assert.deepEqual(normalizeSettings({ unfollow: { whitelist: bad } }).unfollow.whitelist, []);
  }
});

test('unknown keys are dropped instead of persisted', () => {
  const settings = normalizeSettings({
    unfollow: { dailyCap: 10, somethingElse: 'x' },
    unexpected: true,
  });
  assert.deepEqual(Object.keys(settings).sort(), ['favorites', 'schedule', 'unfollow', 'version']);
  assert.equal(settings.unfollow.somethingElse, undefined);
});

test('a bad clock falls back and a good one survives', () => {
  assert.equal(normalizeSettings({ schedule: { time: '25:00' } }).schedule.time, '03:30');
  assert.equal(normalizeSettings({ schedule: { time: '7:5' } }).schedule.time, '03:30');
  assert.equal(normalizeSettings({ schedule: { time: '07:05' } }).schedule.time, '07:05');
  assert.equal(normalizeSettings({ schedule: { time: '00:00' } }).schedule.time, '00:00');
  assert.equal(normalizeSettings({ schedule: { time: '23:59' } }).schedule.time, '23:59');
});

test('isValidClock accepts only 24-hour HH:MM', () => {
  for (const good of ['00:00', '03:30', '23:59']) assert.equal(isValidClock(good), true);
  for (const bad of ['24:00', '3:30', '03:60', '', null, 'noon', '03:30:00']) {
    assert.equal(isValidClock(bad), false);
  }
});

test('the folder id is kept as a string so a large id cannot lose precision', () => {
  const settings = normalizeSettings({ favorites: { folderId: 60971020 } });
  assert.equal(settings.favorites.folderId, '60971020');
  assert.equal(typeof settings.favorites.folderId, 'string');
});

test('a cleared folder id becomes null rather than the string "null"', () => {
  assert.equal(normalizeSettings({ favorites: { folderId: '' } }).favorites.folderId, null);
  assert.equal(normalizeSettings({ favorites: { folderId: null } }).favorites.folderId, null);
});

test('the two enabled flags are deliberately asymmetric', () => {
  // Unfollowing is the default activity, so only an explicit false turns it off.
  assert.equal(normalizeSettings({ unfollow: { enabled: 'false' } }).unfollow.enabled, true);
  assert.equal(normalizeSettings({ unfollow: { enabled: false } }).unfollow.enabled, false);
  assert.equal(normalizeSettings({}).unfollow.enabled, true);

  // Deleting favourites is the riskier action, so only an explicit true turns
  // it on. Anything ambiguous must fail closed.
  assert.equal(normalizeSettings({ favorites: { enabled: true } }).favorites.enabled, true);
  assert.equal(normalizeSettings({ favorites: { enabled: 1 } }).favorites.enabled, false);
  assert.equal(normalizeSettings({ favorites: { enabled: 'true' } }).favorites.enabled, false);
  assert.equal(normalizeSettings({}).favorites.enabled, false);
});

test('a scheduled task must be enabled explicitly too', () => {
  assert.equal(normalizeSettings({ schedule: { enabled: 'yes' } }).schedule.enabled, false);
  assert.equal(normalizeSettings({ schedule: { enabled: 1 } }).schedule.enabled, false);
  assert.equal(normalizeSettings({ schedule: { enabled: true } }).schedule.enabled, true);
});

test('saving normalises before writing, so a bad value never reaches disk', () => {
  const file = tempFile();
  saveSettings({ unfollow: { dailyCap: 1e9 } }, file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).unfollow.dailyCap, HARD_LIMITS.unfollowDailyCap);
});

test('saving creates the directory when it is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-store-'));
  const file = path.join(dir, 'nested', 'deeper', 'settings.json');
  saveSettings({}, file);
  assert.ok(fs.existsSync(file));
});

test('saving leaves no temp file behind', () => {
  const file = tempFile();
  saveSettings({}, file);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
