#!/usr/bin/env node
/**
 * Undo a favourite purge by replaying its log.
 *
 *   node restore-favorites.js --log=logs/favorites-xxx.jsonl            preview
 *   node restore-favorites.js --log=logs/favorites-xxx.jsonl --execute --confirm=XXXXXXXX
 *
 * Only entries logged as successfully deleted are restored. A batch that failed
 * part-way is recorded as failed, because the API does not report per-resource
 * results reliably and blindly re-adding something that is still present could
 * duplicate it.
 *
 * Restoring re-adds the entry but NOT its original favourite time, so a
 * restored item looks freshly collected to later runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadCredentials, describeCredentials, cookieHeader, CredentialsError } from './src/auth.js';
import { createClient, BiliApiError, RISK_CONTROL_CODES } from './src/http.js';
import { addFavoriteResource } from './src/actions.js';
import { confirmToken } from './src/run.js';
import { runMain } from './src/cli.js';

const MAX_PER_RUN = 50;
const MIN_GAP_MS = 2500;
const MAX_GAP_MS = 6000;

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  const takesValue = new Set(['log', 'limit', 'confirm']);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (!takesValue.has(name)) {
      flags.add(name);
      continue;
    }
    const value = inline ?? argv[++index];
    values[name] = name === 'limit' ? Number(value) : String(value);
  }
  return { values, flags };
}

function latestLog() {
  if (!fs.existsSync('logs')) throw new Error('no logs/ directory yet');
  const files = fs.readdirSync('logs')
    .filter((name) => name.startsWith('favorites-') && name.endsWith('.jsonl'))
    .map((name) => `logs/${name}`)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) throw new Error('no favourites logs found');
  return files[0];
}

/** Parse a purge log into the folder it targeted plus its deleted entries. */
export function readRestoreList(file) {
  const text = fs.readFileSync(file, 'utf8');
  let mediaId = null;
  let folderTitle = '';
  const entries = [];

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a truncated final line from an interrupted run
    }

    if (parsed.kind === 'header') {
      mediaId = parsed.mediaId ?? null;
      folderTitle = parsed.folderTitle ?? '';
      continue;
    }
    if (parsed.action === 'favorites' && parsed.ok === true) {
      entries.push({
        id: String(parsed.id),
        type: Number(parsed.type ?? 0),
        title: parsed.title ?? '',
        bvid: parsed.bvid ?? '',
      });
    }
  }

  return { mediaId, folderTitle, entries };
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const executing = flags.has('execute');

  const credentials = loadCredentials();
  console.log('credentials');
  for (const line of describeCredentials(credentials)) console.log(line);
  if (!credentials.ok) {
    for (const problem of credentials.problems) console.error(`  problem: ${problem}`);
    process.exitCode = 2;
    return;
  }
  if (executing && !credentials.writable) {
    console.error('\n--execute needs biliJct.');
    process.exitCode = 2;
    return;
  }

  const logFile = values.log ?? latestLog();
  const { mediaId, folderTitle, entries } = readRestoreList(logFile);
  console.log(`\nlog: ${logFile}`);
  console.log(`  folder "${folderTitle}" (media ${mediaId})`);
  console.log(`  ${entries.length} successfully deleted entr(ies) recorded`);

  if (mediaId === null) {
    console.error('\nthe log has no header, so the target folder is unknown. Refusing to guess.');
    process.exitCode = 3;
    return;
  }
  if (entries.length === 0) {
    console.log('\nnothing to restore.');
    return;
  }

  const limit = Math.min(entries.length, values.limit ?? MAX_PER_RUN);
  const targets = entries.slice(0, limit);
  const token = confirmToken({
    kind: 'restore-favorites',
    mediaId,
    ids: targets.map((entry) => `${entry.id}:${entry.type}`),
  });

  console.log(`\nthis run would restore ${targets.length} of ${entries.length} into "${folderTitle}":`);
  for (const entry of targets.slice(0, 40)) {
    console.log(`  ${String(entry.id).padStart(12)}  ${entry.title}`);
  }
  if (targets.length > 40) console.log(`  ... and ${targets.length - 40} more`);

  if (!executing) {
    console.log('\nDRY RUN -- nothing has been changed.');
    console.log(`  node restore-favorites.js --log=${logFile} --execute --confirm=${token}`);
    return;
  }

  if (values.confirm !== token) {
    console.error('\nconfirm token mismatch.');
    console.error(`  expected: ${token}`);
    console.error(`  given:    ${values.confirm ?? '(none)'}`);
    process.exitCode = 3;
    return;
  }

  const client = createClient({
    cookie: cookieHeader(credentials),
    minGapMs: MIN_GAP_MS,
    maxGapMs: MAX_GAP_MS,
    log: (message) => console.log(message),
  });

  console.log(`\nrestoring ${targets.length} entr(ies)...`);
  let ok = 0;
  let failed = 0;

  for (const [index, entry] of targets.entries()) {
    const position = `[${index + 1}/${targets.length}]`;
    try {
      await addFavoriteResource(client, {
        mediaId, id: entry.id, type: entry.type, csrf: credentials.biliJct,
      });
      ok += 1;
      console.log(`  ${position} OK    ${entry.title}`);
    } catch (error) {
      failed += 1;
      const code = error instanceof BiliApiError ? error.code : 'unknown';
      console.log(`  ${position} FAIL  ${entry.title}  code=${code}`);
      if (RISK_CONTROL_CODES.has(code)) {
        console.log(`\nABORTING on risk-control code ${code}.`);
        break;
      }
    }
  }

  console.log(`\ndone: ${ok} restored, ${failed} failed`);
}

runMain(import.meta.url, main, {
  onCredentialsError: (error) => {
    if (!(error instanceof CredentialsError)) return false;
    console.error(`credentials problem:\n  ${error.message}`);
    process.exitCode = 2;
    return true;
  },
});
