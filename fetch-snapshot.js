#!/usr/bin/env node
/**
 * Step 2: read-only snapshots.
 *
 * This script only ever issues GET requests. It cannot unfollow or delete
 * anything. Its job is to prove we can read the account correctly and to leave
 * a JSON file on disk that you can inspect before any write step exists.
 *
 *   node fetch-snapshot.js --init                 create the credentials template
 *   node fetch-snapshot.js --check                validate credentials, no network
 *   node fetch-snapshot.js --whoami               confirm the cookie works
 *   node fetch-snapshot.js --followings           dump the followings list
 *   node fetch-snapshot.js --folders              list favourite folders
 *   node fetch-snapshot.js --folder <mediaId>     dump one folder
 *   node fetch-snapshot.js --folder <id> --plan   ... and show what a run would drop
 *
 * Useful extras: --limit-pages N (partial fetch), --plan, --seed N,
 *                --mode quantile|span, --out DIR, --show N
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  loadCredentials, describeCredentials, cookieHeader, writeCredentialsTemplate,
  CredentialsError, DEFAULT_CREDENTIALS_PATH,
} from './src/auth.js';
import { createClient, BiliApiError } from './src/http.js';
import {
  getNav, getRelationStat, listAllFollowings, listFavoriteFolders, listAllFavoriteResources,
  normalizeFollowing, normalizeFavorite,
} from './src/bili.js';
import { UNFOLLOW_PRESET, FAVORITE_PRESET, followingsProtection, favoritesProtection } from './src/config.js';
import { renderPlan, planFromRows } from './src/report.js';

const VALUE_FLAGS = new Set(['folder', 'seed', 'limit-pages', 'out', 'show', 'mode', 'min-gap', 'max-gap']);
const NUMBER_FLAGS = new Set(['seed', 'limit-pages', 'show', 'min-gap', 'max-gap']);

function parseArgs(argv) {
  const options = { folders: [], flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=');
    if (!VALUE_FLAGS.has(name)) {
      options.flags.add(name);
      continue;
    }
    const value = inline ?? argv[++index];
    if (name === 'folder') options.folders.push(String(value));
    else options[name] = NUMBER_FLAGS.has(name) ? Number(value) : String(value);
  }
  return options;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function writeSnapshot(dir, name, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}-${stamp()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

function formatCount(value) {
  return typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '?');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outDir = options.out ?? 'snapshots';

  if (options.flags.has('init')) {
    const result = writeCredentialsTemplate();
    console.log(result.created
      ? `created ${result.file}\nOpen it in a text editor and paste your SESSDATA value in.`
      : `${result.file} already exists -- leaving it alone.`);
    if (result.created) {
      console.log('\nWhere to find SESSDATA:');
      console.log('  DevTools -> Application -> Storage -> Cookies -> https://www.bilibili.com');
      console.log('  copy the VALUE column of the SESSDATA row (not the whole cookie string).');
    }
    return;
  }

  let credentials;
  try {
    credentials = loadCredentials();
  } catch (error) {
    if (error instanceof CredentialsError) {
      console.error(`credentials problem:\n  ${error.message}`);
      console.error(`\nRun: node fetch-snapshot.js --init`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  console.log('credentials');
  for (const line of describeCredentials(credentials)) console.log(line);
  for (const warning of credentials.warnings) console.log(`  warning: ${warning}`);

  if (!credentials.ok) {
    console.error('\nproblems:');
    for (const problem of credentials.problems) console.error(`  - ${problem}`);
    console.error(`\nFix ${credentials.file ?? DEFAULT_CREDENTIALS_PATH}, then re-run --check.`);
    process.exitCode = 2;
    return;
  }

  if (options.flags.has('check') && !options.flags.has('whoami')
    && !options.flags.has('followings') && !options.flags.has('folders') && options.folders.length === 0) {
    console.log('\ncredentials look usable. Nothing was sent to the network.');
    console.log('Next: node fetch-snapshot.js --whoami');
    return;
  }

  const client = createClient({
    cookie: cookieHeader(credentials),
    minGapMs: options['min-gap'] ?? 1200,
    maxGapMs: options['max-gap'] ?? 2600,
    log: (message) => console.log(message),
  });

  // Resolve our own mid once; every other call needs it.
  let mid = credentials.mid;
  let uname = null;
  let nav = null;
  try {
    nav = await getNav(client);
    mid = nav.mid;
    uname = nav.uname;
    console.log(`\nsigned in as ${nav.uname} (mid ${nav.mid})`);
  } catch (error) {
    if (error instanceof BiliApiError) {
      console.error(`\n${error.message}`);
      if (String(error.code) === '-101') console.error('SESSDATA is stale or mistyped. Re-copy it from the browser.');
      process.exitCode = 3;
      return;
    }
    throw error;
  }

  if (options.flags.has('whoami')) {
    const stat = await getRelationStat(client, mid);
    if (stat.following !== null) {
      console.log(`following ${stat.following}   followers ${stat.follower ?? '?'}`);
    }
    console.log('cookie works. Read-only access confirmed.');
    return;
  }

  const limitPages = options['limit-pages'];

  if (options.flags.has('followings')) {
    console.log('\nfetching followings...');
    const { rows, total, complete } = await listAllFollowings(client, mid, {
      maxPages: limitPages ?? 400,
      onPage: ({ page, got, rows: seen, total: reported }) => {
        console.log(`  page ${page}: +${got} (${seen}/${formatCount(reported)})`);
      },
    });

    const items = rows.map(normalizeFollowing);
    const file = writeSnapshot(outDir, 'followings', {
      fetchedAt: new Date().toISOString(),
      mid,
      uname,
      reportedTotal: total,
      fetched: items.length,
      complete,
      partial: limitPages !== undefined,
      items,
    });

    console.log(`\nfetched ${items.length} followings (api reported ${formatCount(total)})`);
    if (!complete && limitPages === undefined) {
      console.log('  note: fewer rows than the reported total -- the API may cap deep pagination');
    }
    console.log(`  special follows: ${items.filter((i) => i.special).length}`);
    console.log(`  mutual follows:  ${items.filter((i) => i.mutual).length}`);
    console.log(`  wrote ${file}`);

    if (options.flags.has('plan')) {
      const config = {
        ...UNFOLLOW_PRESET,
        mode: options.mode ?? UNFOLLOW_PRESET.mode,
        seed: options.seed ?? UNFOLLOW_PRESET.seed,
        isProtected: followingsProtection({
          special: UNFOLLOW_PRESET.protectSpecial,
          mutual: UNFOLLOW_PRESET.protectMutual,
        }),
      };
      const { result } = planFromRows(items, 'followings', config);
      console.log(renderPlan(result, {
        title: 'unfollow plan (nothing has been changed)',
        listLimit: options.show ?? 20,
      }));
    }
  }

  if (options.flags.has('folders')) {
    console.log('\nfetching favourite folders...');
    const folders = await listFavoriteFolders(client, mid);
    const file = writeSnapshot(outDir, 'folders', {
      fetchedAt: new Date().toISOString(),
      mid,
      folders: folders.map(({ mediaId, title, count, isDefault }) => ({ mediaId, title, count, isDefault })),
    });
    console.log(`\n${folders.length} folders:`);
    for (const folder of folders) {
      console.log(`  ${String(folder.mediaId).padStart(12)}  ${String(folder.count).padStart(6)}  `
        + `${folder.title}${folder.isDefault ? '  [default]' : ''}`);
    }
    console.log(`  wrote ${file}`);
  }

  for (const mediaId of options.folders) {
    console.log(`\nfetching favourite folder ${mediaId}...`);
    const { rows, info } = await listAllFavoriteResources(client, mediaId, {
      maxPages: limitPages ?? 1000,
      onPage: ({ page, got, rows: seen, total }) => {
        console.log(`  page ${page}: +${got} (${seen}${total ? `/${total}` : ''})`);
      },
    });

    const folder = { mediaId, title: info?.title ?? '' };
    const items = rows.map((media) => normalizeFavorite(media, folder));
    const invalid = items.filter((item) => item.invalid);
    const reportedCount = info?.media_count ?? null;

    // The folder listing can stop short of media_count: deep pagination is not
    // perfectly stable, so entries shift between pages. Without this check the
    // snapshot would silently cover less than the whole folder, and the ruler
    // would treat that subset as the entire population.
    const complete = reportedCount === null || items.length >= reportedCount;

    const file = writeSnapshot(outDir, `fav-${mediaId}`, {
      fetchedAt: new Date().toISOString(),
      mid,
      mediaId,
      title: folder.title,
      reportedCount,
      fetched: items.length,
      complete,
      partial: limitPages !== undefined,
      invalidCount: invalid.length,
      items,
    });

    console.log(`\nfetched ${items.length} entries from "${folder.title}" (api reported ${formatCount(reportedCount)})`);
    if (!complete) {
      console.log(`  WARNING: ${reportedCount - items.length} entr(ies) short of the reported count.`);
      console.log('  The listing stopped early, so this snapshot does NOT cover the whole folder.');
      console.log('  Do not run a purge against it -- re-fetch first.');
    }
    console.log(`  flagged as dead: ${invalid.length}`);
    const reasons = new Map();
    for (const item of invalid) reasons.set(item.invalidReason, (reasons.get(item.invalidReason) ?? 0) + 1);
    for (const [reason, count] of reasons) console.log(`    ${count} x ${reason}`);
    console.log(`  wrote ${file}`);

    if (options.flags.has('plan')) {
      const config = {
        ...FAVORITE_PRESET,
        mode: options.mode ?? FAVORITE_PRESET.mode,
        seed: options.seed ?? FAVORITE_PRESET.seed,
        isProtected: favoritesProtection(),
      };
      const { result } = planFromRows(items, 'favorites', config);
      console.log(renderPlan(result, {
        title: `favourite purge plan for "${folder.title}" (nothing has been changed)`,
        listLimit: options.show ?? 20,
      }));
    }
  }

  const stats = client.stats;
  console.log(`\nrequests: ${stats.requestCount}, retries: ${stats.retryCount}`);
}

main().catch((error) => {
  console.error(`\nunexpected failure: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
