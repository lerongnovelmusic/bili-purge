#!/usr/bin/env node
/**
 * The unattended daily run, for Windows Task Scheduler.
 *
 *   node daily.js            refresh snapshots, then run up to today's quota
 *   node daily.js --dry      do everything except the writes
 *   node daily.js --only=unfollow
 *
 * Why this is separate from the CLIs: the CLIs are human-driven, so they can
 * stop and ask for a confirm token. Nobody is present here, so the quota and
 * the settings file ARE the authorisation. Installing the task is the consent.
 *
 * It refreshes the snapshot first, every time. A scheduled run against a
 * month-old snapshot would plan against a population that no longer exists --
 * the ruler would be ranking the wrong set of people.
 *
 * Exit codes matter, because Task Scheduler records them:
 *   0  ran, or nothing was due
 *   1  could not run (bad settings, missing or expired credentials, fetch failed)
 *   2  stopped early by risk control -- the account is being throttled
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadCredentials, cookieHeader } from './src/auth.js';
import { createClient, BiliApiError, RISK_CONTROL_CODES } from './src/http.js';
import {
  getNav, listAllFollowings, listAllFavoriteResources, normalizeFollowing, normalizeFavorite,
} from './src/bili.js';
import { loadSettings } from './src/store.js';
import { buildUnfollowRun, buildFavoriteRun } from './src/run.js';
import { executeUnfollow, executeFavorites } from './src/execute.js';
import { localDateKey, usedOn } from './src/quota.js';
import { UNFOLLOW_PRESET, FAVORITE_PRESET } from './src/config.js';
import { LOG_DIR, SNAPSHOT_DIR, ranOnLocalDate } from './src/history.js';
import { runMain } from './src/cli.js';

const EXIT = { ok: 0, error: 1, riskControl: 2 };

/** `--dry` becomes flag "dry"; `--only=unfollow` becomes value "only". */
function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else values.set(body.slice(0, eq), body.slice(eq + 1));
  }
  return { flags, values };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function writeSnapshot(name, payload) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const file = path.join(SNAPSHOT_DIR, `${name}-${stamp()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/** A JSONL writer that appends each record as it happens. */
function makeLog(action) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `${action}-${stamp()}.jsonl`);
  const handle = fs.createWriteStream(file, { flags: 'a' });
  return {
    file,
    write(record) {
      handle.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
    },
    close() {
      return new Promise((resolve) => handle.end(resolve));
    },
  };
}

// ------------------------------------------------------------------ steps
async function refreshFollowings(client, mid) {
  const { rows, total, complete } = await listAllFollowings(client, mid, { maxPages: 400 });
  const items = rows.map(normalizeFollowing);
  const file = writeSnapshot('followings', {
    fetchedAt: new Date().toISOString(),
    mid,
    reportedTotal: total,
    fetched: items.length,
    complete,
    partial: false,
    items,
  });
  return { file, items, total, complete };
}

async function refreshFolder(client, mediaId) {
  const { rows, info } = await listAllFavoriteResources(client, mediaId, { maxPages: 1000 });
  const folder = { mediaId, title: info?.title ?? '' };
  const items = rows.map((media) => normalizeFavorite(media, folder));
  const reportedCount = info?.media_count ?? null;
  const file = writeSnapshot(`fav-${mediaId}`, {
    fetchedAt: new Date().toISOString(),
    mediaId,
    title: folder.title,
    reportedCount,
    fetched: items.length,
    complete: reportedCount === null || items.length >= reportedCount,
    partial: false,
    invalidCount: items.filter((item) => item.invalid).length,
    items,
  });
  return { file, items, title: folder.title, reportedCount };
}

// ------------------------------------------------------------------- main
async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const dry = flags.has('dry');
  const only = values.get('only') ?? null;
  const settings = loadSettings();

  const wantUnfollow = settings.unfollow.enabled && (!only || only === 'unfollow');
  const wantFavorites = settings.favorites.enabled && (!only || only === 'favorites');

  if (!wantUnfollow && !wantFavorites) {
    console.log('nothing is enabled in settings -- nothing to do.');
    return EXIT.ok;
  }

  const credentials = loadCredentials();
  if (!credentials.ok) {
    console.error('cannot run: credentials are missing or unusable.');
    for (const problem of credentials.problems) console.error(`  ${problem}`);
    console.error(`  edit ${credentials.file ?? 'the credentials file'} or use the GUI to paste fresh cookies.`);
    return EXIT.error;
  }
  if (!credentials.writable) {
    console.error('cannot run: biliJct is missing, and the write endpoints require it.');
    return EXIT.error;
  }

  console.log(`daily run ${new Date().toISOString()}${dry ? '  [DRY RUN]' : ''}`);

  const client = createClient({
    cookie: cookieHeader(credentials),
    minGapMs: UNFOLLOW_PRESET.minGapMs,
    maxGapMs: UNFOLLOW_PRESET.maxGapMs,
    log: (line) => console.log(line),
  });

  let nav;
  try {
    nav = await getNav(client);
  } catch (error) {
    // An expired SESSDATA is the single most likely scheduled failure, so name
    // it explicitly instead of reporting a bare API code.
    const detail = error instanceof BiliApiError ? `${error.code}: ${error.apiMessage}` : String(error.message);
    console.error(`cannot run: could not authenticate (${detail}).`);
    console.error('  This usually means SESSDATA has expired. Paste fresh cookies in the GUI.');
    return EXIT.error;
  }
  console.log(`signed in as ${nav.uname} (mid ${nav.mid})`);

  const today = localDateKey(new Date());
  let worstExit = EXIT.ok;

  // ------------------------------------------------------------ unfollow
  if (wantUnfollow) {
    const used = usedOn(LOG_DIR, today);
    const remaining = Math.max(0, settings.unfollow.dailyCap - used);
    console.log(`\n[unfollow] today ${used}/${settings.unfollow.dailyCap}, ${remaining} left`);

    if (remaining === 0) {
      console.log('[unfollow] daily quota already used up -- skipping');
    } else {
      const snapshot = await refreshFollowings(client, nav.mid);
      console.log(`[unfollow] snapshot: ${snapshot.items.length} followings (api reported ${snapshot.total})`
        + (snapshot.complete ? '' : '  [INCOMPLETE]'));

      const run = buildUnfollowRun({
        rows: snapshot.items,
        cap: settings.unfollow.freshCapDays,
        keep: settings.unfollow.whitelist,
        limit: Math.min(settings.unfollow.perRun, remaining),
        now: new Date(),
        preset: { ...UNFOLLOW_PRESET, maxPerRun: settings.unfollow.perRun, maxPerDay: settings.unfollow.dailyCap },
      });

      console.log(`[unfollow] planned ${run.result.drop.length} removals, this run ${run.actions.length}`);

      if (run.actions.length === 0) {
        console.log('[unfollow] nothing to do');
      } else if (dry) {
        for (const item of run.actions) console.log(`  would unfollow ${item.id} ${item.label} (${Math.round(item.ageDays)}d)`);
      } else {
        const log = makeLog('unfollow');
        log.write({
          kind: 'header', action: 'unfollow', source: 'daily', token: run.token,
          cap: String(settings.unfollow.freshCapDays), planned: run.actions.length, snapshot: snapshot.file,
        });
        const summary = await executeUnfollow({
          client, actions: run.actions, csrf: credentials.biliJct,
          onRecord: (record) => {
            log.write(record);
            console.log(`  ${record.ok ? 'ok  ' : 'FAIL'} ${record.mid} ${record.uname}`
              + (record.ok ? '' : `  [${record.code}] ${record.message}`));
          },
        });
        log.write({ kind: 'summary', ok: summary.ok, failed: summary.failed, aborted: summary.aborted });
        await log.close();

        console.log(`[unfollow] ${summary.ok} ok, ${summary.failed} failed -> ${log.file}`);
        if (summary.aborted) {
          console.error('[unfollow] STOPPED by risk control. Do not retry today.');
          worstExit = EXIT.riskControl;
        }
      }
    }
  }

  // ----------------------------------------------------------- favourites
  if (wantFavorites) {
    if (!settings.favorites.folderId) {
      console.log('\n[favorites] enabled but no folder is selected -- skipping');
    } else {
      const used = usedOn(LOG_DIR, today, { action: 'favorites' });
      const remaining = Math.max(0, settings.favorites.dailyCap - used);
      console.log(`\n[favorites] today ${used}/${settings.favorites.dailyCap}, ${remaining} left`);

      if (remaining === 0) {
        console.log('[favorites] daily quota already used up -- skipping');
      } else {
        const snapshot = await refreshFolder(client, settings.favorites.folderId);
        console.log(`[favorites] snapshot "${snapshot.title}": ${snapshot.items.length} entries`
          + (snapshot.reportedCount ? ` (api reported ${snapshot.reportedCount})` : ''));

        const run = buildFavoriteRun({
          rows: snapshot.items,
          cap: settings.favorites.freshCapDays,
          keep: settings.favorites.whitelist,
          limit: Math.min(settings.favorites.perRun, remaining),
          now: new Date(),
          preset: { ...FAVORITE_PRESET, maxPerRun: settings.favorites.perRun, maxPerDay: settings.favorites.dailyCap },
        });

        console.log(`[favorites] planned ${run.result.drop.length} removals, this run ${run.actions.length}`);

        if (run.actions.length === 0) {
          console.log('[favorites] nothing to do');
        } else if (dry) {
          for (const item of run.actions) console.log(`  would remove ${item.id} ${item.label} (${Math.round(item.ageDays)}d)`);
        } else {
          const log = makeLog('favorites');
          log.write({
            kind: 'header', action: 'favorites', source: 'daily', token: run.token,
            cap: String(settings.favorites.freshCapDays), planned: run.actions.length,
            mediaId: snapshot.items[0]?.mediaId ?? settings.favorites.folderId,
            folderTitle: snapshot.title, snapshot: snapshot.file,
          });
          const summary = await executeFavorites({
            client, mediaId: settings.favorites.folderId, actions: run.actions, csrf: credentials.biliJct,
            onRecord: (record) => {
              log.write(record);
              if (!record.ok) console.log(`  FAIL ${record.id} ${record.title}  [${record.code}] ${record.message}`);
            },
            onBatch: ({ index, total, size, ok, code, message }) => {
              console.log(`  batch ${index}/${total} (${size} items) ${ok ? 'ok' : `FAIL [${code}] ${message}`}`);
            },
          });
          log.write({ kind: 'summary', ok: summary.ok, failed: summary.failed, aborted: summary.aborted });
          await log.close();

          console.log(`[favorites] ${summary.ok} ok, ${summary.failed} failed -> ${log.file}`);
          if (summary.aborted) {
            console.error('[favorites] STOPPED by risk control. Do not retry today.');
            worstExit = EXIT.riskControl;
          }
        }
      }
    }
  }

  console.log(`\ndone. requests ${client.stats.requestCount}, retries ${client.stats.retryCount}`);
  if (ranOnLocalDate(today, LOG_DIR)) console.log('a run is now logged for today.');
  return worstExit;
}

runMain(import.meta.url, main, {
  onError: (error) => {
    console.error(`daily run failed: ${error?.message ?? error}`);
    process.exitCode = EXIT.error;
  },
});
