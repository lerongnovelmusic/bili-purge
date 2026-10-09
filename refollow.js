#!/usr/bin/env node
/**
 * Undo an unfollow run by replaying its log.
 *
 * Unfollowing is the one action here with no server-side undo, which is why
 * unfollow.js writes a JSONL log and why this script exists. It re-follows the
 * accounts recorded as successfully unfollowed.
 *
 *   node refollow.js --log=logs/unfollow-xxx.jsonl            preview
 *   node refollow.js --log=logs/unfollow-xxx.jsonl --execute --confirm=XXXXXXXX
 *
 * Note: re-following restores the relationship but NOT the original follow
 * date, so the account will look "newly followed" to future runs.
 */
import fs from 'node:fs';

import { loadCredentials, describeCredentials, cookieHeader, CredentialsError } from './src/auth.js';
import { createClient, BiliApiError, RISK_CONTROL_CODES } from './src/http.js';
import { refollow } from './src/actions.js';
import { confirmToken } from './src/run.js';
import { runMain } from './src/cli.js';

const MAX_PER_RUN = 30;
const MIN_GAP_MS = 1500;
const MAX_GAP_MS = 4000;

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
    .filter((name) => name.startsWith('unfollow-') && name.endsWith('.jsonl'))
    .map((name) => `logs/${name}`)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files.length === 0) throw new Error('no unfollow logs found');
  return files[0];
}

/** Every successfully unfollowed account recorded in a log. */
export function readUndoList(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.action === 'unfollow' && parsed.ok === true) {
      entries.push({ mid: String(parsed.mid), uname: parsed.uname, ts: parsed.ts });
    }
  }
  return entries;
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
  const entries = readUndoList(logFile);
  console.log(`\nlog: ${logFile}`);
  console.log(`  ${entries.length} successfully unfollowed account(s) recorded`);

  if (entries.length === 0) {
    console.log('\nnothing to restore.');
    return;
  }

  const limit = Math.min(entries.length, values.limit ?? MAX_PER_RUN);
  const targets = entries.slice(0, limit);
  const token = confirmToken({ kind: 'refollow', ids: targets.map((entry) => entry.mid) });

  console.log(`\nthis run would re-follow ${targets.length} of ${entries.length}:`);
  for (const entry of targets) {
    console.log(`  ${entry.mid.padStart(16)}  ${entry.uname}  (unfollowed ${entry.ts})`);
  }

  if (!executing) {
    console.log('\nDRY RUN -- nothing has been changed.');
    console.log(`  node refollow.js --log=${logFile} --execute --confirm=${token}`);
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

  console.log(`\nre-following ${targets.length} account(s)...`);
  let ok = 0;
  let failed = 0;

  for (const [index, entry] of targets.entries()) {
    const position = `[${index + 1}/${targets.length}]`;
    try {
      await refollow(client, { fid: entry.mid, csrf: credentials.biliJct });
      ok += 1;
      console.log(`  ${position} OK    ${entry.uname} (${entry.mid})`);
    } catch (error) {
      failed += 1;
      const code = error instanceof BiliApiError ? error.code : 'unknown';
      console.log(`  ${position} FAIL  ${entry.uname} (${entry.mid})  code=${code}`);
      if (RISK_CONTROL_CODES.has(code)) {
        console.log(`\nABORTING on risk-control code ${code}.`);
        break;
      }
    }
  }

  console.log(`\ndone: ${ok} re-followed, ${failed} failed`);
}

runMain(import.meta.url, main, {
  onCredentialsError: (error) => {
    if (!(error instanceof CredentialsError)) return false;
    console.error(`credentials problem:\n  ${error.message}`);
    process.exitCode = 2;
    return true;
  },
});
