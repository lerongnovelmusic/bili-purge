#!/usr/bin/env node
/**
 * A local control panel for the purge scripts.
 *
 *   node gui.js                 open http://127.0.0.1:8791
 *   node gui.js --port=9000
 *
 * Zero dependencies: Node's own HTTP server and one HTML page. It binds to
 * 127.0.0.1 only, and every API call must carry a per-session token that is
 * generated at startup and embedded in the page.
 *
 * That token is the CSRF defence, and it matters: a page on any website can
 * POST to http://127.0.0.1 without reading the response. Requiring a custom
 * header forces a CORS preflight, which this server never approves, so a
 * foreign page cannot reach these endpoints at all.
 *
 * The GUI never fabricates a confirm token. It asks the same planner the CLI
 * uses, shows the resulting plan, and will only execute against the token that
 * plan produced.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';

import { loadCredentials, describeCredentials, cookieHeader, DEFAULT_CREDENTIALS_PATH } from './src/auth.js';
import { parseCredentialBlob, describeBlob } from './src/credentials-input.js';
import { createClient, BiliApiError } from './src/http.js';
import { getNav, getRelationStat, listFavoriteFolders } from './src/bili.js';
import { loadSettings, saveSettings, defaultSettings } from './src/store.js';
import { buildUnfollowRun, buildFavoriteRun } from './src/run.js';
import { executeUnfollow, executeFavorites } from './src/execute.js';
import { localDateKey, usedOn, usageByDay } from './src/quota.js';
import { UNFOLLOW_PRESET, FAVORITE_PRESET } from './src/config.js';
import { installDailyTask, removeDailyTask, dailyTaskStatus } from './src/scheduler.js';
import { renderPlan } from './src/report.js';
import { runMain } from './src/cli.js';
import { LOG_DIR, newestSnapshot, readHistory } from './src/history.js';
import { generateQr, pollQr } from './src/qrlogin.js';

const DEFAULT_PORT = 8791;
const SESSION_TOKEN = randomBytes(16).toString('hex');

/**
 * The QR handshake in progress, if any. One at a time: the browser renders a
 * single code and polls it.
 *
 * The QR client is created once and reused so its throttle still applies --
 * polling every few seconds must not become a burst.
 */
let pendingQr = null;
const qrClient = createClient({ minGapMs: 900, maxGapMs: 1600, maxRetries: 1, log: () => {} });

// ---------------------------------------------------------------- helpers
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('request body was not valid JSON');
  }
}

/** Credential status with no secret material, plus the live counters. */
function credentialState() {
  let credentials;
  try {
    credentials = loadCredentials();
  } catch (error) {
    return { ok: false, problems: [error.message], lines: [] };
  }
  return {
    ok: credentials.ok,
    writable: credentials.writable,
    problems: credentials.problems,
    warnings: credentials.warnings,
    lines: describeCredentials(credentials),
    file: credentials.file,
  };
}

/** The buckets a favourite snapshot could be planned from. */
function folderState() {
  const file = newestSnapshot('fav-');
  if (!file) return { snapshot: null, folders: [] };

  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  let folders = [];
  const foldersFile = newestSnapshot('folders-');
  if (foldersFile) {
    folders = JSON.parse(fs.readFileSync(foldersFile, 'utf8')).folders ?? [];
  }
  return {
    snapshot: {
      file,
      mediaId: snapshot.mediaId,
      title: snapshot.title,
      fetched: snapshot.fetched,
      reportedCount: snapshot.reportedCount ?? null,
      invalidCount: snapshot.invalidCount ?? null,
      fetchedAt: snapshot.fetchedAt,
      incomplete: typeof snapshot.reportedCount === 'number' && snapshot.fetched < snapshot.reportedCount,
    },
    folders,
  };
}

function followingsState() {
  const file = newestSnapshot('followings-');
  if (!file) return null;
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    file,
    fetched: snapshot.fetched,
    reportedTotal: snapshot.reportedTotal ?? null,
    complete: snapshot.complete !== false,
    fetchedAt: snapshot.fetchedAt,
  };
}

function clientFor(credentials, preset) {
  return createClient({
    cookie: cookieHeader(credentials),
    minGapMs: preset.minGapMs,
    maxGapMs: preset.maxGapMs,
    log: () => {},
  });
}

/** Assemble a plan for one action kind, using saved settings. */
function planFor(kind, credentials) {
  const settings = loadSettings();
  const today = localDateKey(new Date());

  if (kind === 'unfollow') {
    const file = newestSnapshot('followings-');
    if (!file) throw new Error('no followings snapshot yet');
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    const config = settings.unfollow;
    const used = usedOn(LOG_DIR, today);
    const remaining = Math.max(0, config.dailyCap - used);

    const run = buildUnfollowRun({
      rows: snapshot.items ?? [],
      cap: config.freshCapDays,
      keep: config.whitelist,
      limit: Math.min(config.perRun, remaining),
      now: new Date(snapshot.fetchedAt),
      preset: { ...UNFOLLOW_PRESET, maxPerDay: config.dailyCap, maxPerRun: config.perRun },
    });

    return {
      kind, run, settings, snapshot: { file, fetched: snapshot.fetched, fetchedAt: snapshot.fetchedAt },
      quota: { used, cap: config.dailyCap, remaining, action: 'unfollow' },
      table: renderPlan(run.result, { title: 'unfollow plan', listLimit: 0 }),
    };
  }

  const file = newestSnapshot('fav-');
  if (!file) throw new Error('no favourite snapshot yet');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = settings.favorites;
  const used = usedOn(LOG_DIR, today, { action: 'favorites' });
  const remaining = Math.max(0, config.dailyCap - used);

  const run = buildFavoriteRun({
    rows: snapshot.items ?? [],
    cap: config.freshCapDays,
    keep: config.whitelist,
    limit: Math.min(config.perRun, remaining),
    now: new Date(snapshot.fetchedAt),
    preset: { ...FAVORITE_PRESET, maxPerDay: config.dailyCap, maxPerRun: config.perRun },
  });

  return {
    kind,
    run,
    settings,
    snapshot: {
      file, mediaId: snapshot.mediaId, title: snapshot.title,
      fetched: snapshot.fetched, fetchedAt: snapshot.fetchedAt,
      reportedCount: snapshot.reportedCount ?? null,
      incomplete: typeof snapshot.reportedCount === 'number' && snapshot.fetched < snapshot.reportedCount,
    },
    quota: { used, cap: config.dailyCap, remaining, action: 'favorites' },
    table: renderPlan(run.result, { title: 'favourite plan', listLimit: 0 }),
  };
}

/** Serialise a plan without leaking whole snapshots. */
function planPayload(plan) {
  return {
    kind: plan.kind,
    table: plan.table,
    token: plan.run.token,
    snapshot: plan.snapshot,
    quota: plan.quota,
    plannedTotal: plan.run.result.drop.length,
    actionCount: plan.run.actions.length,
    keepCount: plan.run.result.keep.length,
    actions: plan.run.actions.slice(0, 200).map((item) => ({
      id: item.id,
      label: item.label,
      ageDays: Math.round(item.ageDays),
      dead: Boolean(item.raw?.invalid),
    })),
    truncated: Math.max(0, plan.run.actions.length - 200),
    batches: plan.kind === 'favorites'
      ? Math.ceil(plan.run.actions.length / 20)
      : plan.run.actions.length,
  };
}

/** Drop-in background filenames, in preference order. */
const BACKGROUND_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'svg'];

/** Formats a browser upload may claim. SVG is excluded: it can carry script. */
const UPLOADABLE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif']);

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;     // the JSON envelope, base64 included
const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;  // the decoded image itself

/**
 * Does the payload actually start like the format it claims?
 *
 * The extension is attacker-controlled in principle, and a "png" that is really
 * an HTML file would be served back from this origin. Checking the signature
 * keeps the assets directory to images.
 */
function looksLikeImage(bytes, ext) {
  const startsWith = (...signature) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

  if (ext === 'jpg' || ext === 'jpeg') return startsWith(0xff, 0xd8, 0xff);
  if (ext === 'png') return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (ext === 'gif') return startsWith(0x47, 0x49, 0x46, 0x38);
  if (ext === 'webp') {
    return startsWith(0x52, 0x49, 0x46, 0x46)
      && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  }
  if (ext === 'avif') {
    return bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp';
  }
  return false;
}

function assetsDir() {
  return path.join(import.meta.dirname, 'gui', 'assets');
}

/**
 * Which background the page should paint.
 *
 * A file named background.<ext> dropped into gui/assets/ wins, so the console
 * can be pointed at your own artwork without touching any code. Otherwise the
 * bundled backdrop is used -- that one is original art drawn for this tool, not
 * Bilibili's, so it can ship with the project.
 */
function backgroundFor() {
  const dir = assetsDir();
  for (const ext of UPLOADABLE_EXTS) {
    const file = path.join(dir, `background.${ext}`);
    // The mtime is part of the URL so a replaced image is never served from cache.
    if (fs.existsSync(file)) {
      return `/assets/background.${ext}?v=${Math.round(fs.statSync(file).mtimeMs)}`;
    }
  }
  const backdrop = path.join(dir, 'backdrop.svg');
  return fs.existsSync(backdrop) ? '/assets/backdrop.svg' : null;
}

// ------------------------------------------------------------------ routes
async function handle(req, res, url) {
  const route = url.pathname;

  if (route === '/' || route === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(SESSION_TOKEN));
    return;
  }

  if (route.startsWith('/assets/')) {
    // basename() collapses any traversal attempt to a single filename, and only
    // files sitting in gui/assets/ are ever reachable.
    const name = path.basename(route);
    const file = path.join(import.meta.dirname, 'gui', 'assets', name);
    if (name === '' || !fs.existsSync(file)) {
      json(res, 404, { error: 'no such asset' });
      return;
    }
    const types = {
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
      '.avif': 'image/avif',
    };
    res.writeHead(200, {
      'Content-Type': types[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(fs.readFileSync(file));
    return;
  }

  if (!route.startsWith('/api/')) {
    json(res, 404, { error: 'not found' });
    return;
  }

  // Every API call must carry the session token.
  if (req.headers['x-bili-purge-token'] !== SESSION_TOKEN) {
    json(res, 403, { error: 'missing or wrong session token' });
    return;
  }

  if (route === '/api/state' && req.method === 'GET') {
    json(res, 200, {
      settings: loadSettings(),
      defaults: defaultSettings(),
      credentials: credentialState(),
      followings: followingsState(),
      favorites: folderState(),
      usage: usageByDay(LOG_DIR, { days: 7 }),
      history: readHistory(LOG_DIR, 12),
      task: dailyTaskStatus(),
      background: backgroundFor(),
      limits: { unfollow: UNFOLLOW_PRESET, favorites: FAVORITE_PRESET },
    });
    return;
  }

  // The page downscales before uploading, so this only ever receives a modest
  // JPEG. The limit is generous anyway, and the decoded size is checked again.
  if (route === '/api/background' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req, MAX_UPLOAD_BYTES);
    } catch (error) {
      json(res, 413, { error: String(error.message) });
      return;
    }

    const ext = String(body.ext ?? '').toLowerCase().replace(/^\./, '');
    if (!UPLOADABLE_EXTS.has(ext)) {
      json(res, 400, { error: `unsupported image type: ${ext || '(none)'}` });
      return;
    }

    const bytes = Buffer.from(String(body.data ?? ''), 'base64');
    if (bytes.length === 0) {
      json(res, 400, { error: 'the upload was empty' });
      return;
    }
    if (bytes.length > MAX_BACKGROUND_BYTES) {
      json(res, 413, {
        error: `image is ${(bytes.length / 1048576).toFixed(1)} MB, limit is ${MAX_BACKGROUND_BYTES / 1048576} MB`,
      });
      return;
    }
    if (!looksLikeImage(bytes, ext)) {
      json(res, 400, { error: `the file does not look like a ${ext}` });
      return;
    }

    const dir = assetsDir();
    fs.mkdirSync(dir, { recursive: true });
    // One background at a time, so the priority order never has to be guessed.
    for (const other of UPLOADABLE_EXTS) {
      const stale = path.join(dir, `background.${other}`);
      if (fs.existsSync(stale)) fs.rmSync(stale);
    }
    fs.writeFileSync(path.join(dir, `background.${ext}`), bytes);
    json(res, 200, { ok: true, url: backgroundFor(), bytes: bytes.length });
    return;
  }

  if (route === '/api/background/clear' && req.method === 'POST') {
    const dir = assetsDir();
    let removed = 0;
    for (const ext of UPLOADABLE_EXTS) {
      const file = path.join(dir, `background.${ext}`);
      if (fs.existsSync(file)) { fs.rmSync(file); removed += 1; }
    }
    json(res, 200, { ok: true, removed, url: backgroundFor() });
    return;
  }

  if (route === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    const saved = saveSettings(body.settings ?? {});
    json(res, 200, { settings: saved });
    return;
  }

  if (route === '/api/credentials' && req.method === 'POST') {
    const body = await readBody(req);
    const parsed = body.blob
      ? parseCredentialBlob(body.blob)
      : { sessdata: String(body.sessdata ?? ''), biliJct: String(body.biliJct ?? ''), mid: String(body.mid ?? '') };

    const sessdata = parsed.sessdata || String(body.sessdata ?? '');
    const biliJct = parsed.biliJct || String(body.biliJct ?? '');
    const mid = parsed.mid || String(body.mid ?? '');

    if (!sessdata) {
      json(res, 400, { error: describeBlob(parsed) });
      return;
    }

    fs.mkdirSync(path.dirname(DEFAULT_CREDENTIALS_PATH), { recursive: true });
    const existing = fs.existsSync(DEFAULT_CREDENTIALS_PATH)
      ? JSON.parse(fs.readFileSync(DEFAULT_CREDENTIALS_PATH, 'utf8'))
      : {};
    const next = { ...existing, sessdata, biliJct: biliJct || existing.biliJct || '' };
    if (mid) next.mid = Number(mid) || mid;

    fs.writeFileSync(DEFAULT_CREDENTIALS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    // Never echo the values back.
    json(res, 200, { saved: true, found: parsed.found, credentials: credentialState() });
    return;
  }

  if (route === '/api/credentials/clear' && req.method === 'POST') {
    if (fs.existsSync(DEFAULT_CREDENTIALS_PATH)) fs.rmSync(DEFAULT_CREDENTIALS_PATH);
    json(res, 200, { cleared: true, credentials: credentialState() });
    return;
  }

  // ---------------------------------------------------------- QR login
  if (route === '/api/login/qr/start' && req.method === 'POST') {
    try {
      const { url, qrcodeKey } = await generateQr(qrClient);
      // The URL is the login URL, so it stays on this machine: the browser gets
      // a picture of it, never the link to open by hand.
      const svg = await QRCode.toString(url, {
        type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M',
      });
      pendingQr = { qrcodeKey, startedAt: Date.now() };
      json(res, 200, { svg });
    } catch (error) {
      json(res, 400, { error: error instanceof BiliApiError ? `${error.code}: ${error.apiMessage}` : String(error.message) });
    }
    return;
  }

  if (route === '/api/login/qr/poll' && req.method === 'POST') {
    if (!pendingQr) {
      json(res, 400, { error: '没有正在进行的扫码，请重新生成二维码。' });
      return;
    }
    try {
      const result = await pollQr(qrClient, pendingQr.qrcodeKey);

      if (result.status === 'success' && result.credentials.sessdata) {
        fs.mkdirSync(path.dirname(DEFAULT_CREDENTIALS_PATH), { recursive: true });
        const existing = fs.existsSync(DEFAULT_CREDENTIALS_PATH)
          ? JSON.parse(fs.readFileSync(DEFAULT_CREDENTIALS_PATH, 'utf8'))
          : {};
        // bili_jct may be absent on some responses; keep the old one if so.
        const next = { ...existing, sessdata: result.credentials.sessdata };
        if (result.credentials.biliJct) next.biliJct = result.credentials.biliJct;
        if (result.credentials.mid) next.mid = Number(result.credentials.mid) || result.credentials.mid;
        fs.writeFileSync(DEFAULT_CREDENTIALS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

        pendingQr = null;
        json(res, 200, { status: 'success', hasCsrf: Boolean(next.biliJct), credentials: credentialState() });
        return;
      }

      if (result.status === 'expired') pendingQr = null;
      json(res, 200, { status: result.status });
    } catch (error) {
      json(res, 400, { error: error instanceof BiliApiError ? `${error.code}: ${error.apiMessage}` : String(error.message) });
    }
    return;
  }

  if (route === '/api/login/qr/cancel' && req.method === 'POST') {
    pendingQr = null;
    json(res, 200, { cancelled: true });
    return;
  }

  if (route === '/api/verify' && req.method === 'POST') {
    const credentials = loadCredentials();
    if (!credentials.ok) {
      json(res, 400, { error: credentials.problems.join('; ') });
      return;
    }
    const client = clientFor(credentials, UNFOLLOW_PRESET);
    try {
      const nav = await getNav(client);
      const stat = await getRelationStat(client, nav.mid);
      json(res, 200, { nav, stat });
    } catch (error) {
      json(res, 400, { error: error instanceof BiliApiError ? `${error.code}: ${error.apiMessage}` : String(error.message) });
    }
    return;
  }

  if (route === '/api/folders/refresh' && req.method === 'POST') {
    const credentials = loadCredentials();
    if (!credentials.ok) {
      json(res, 400, { error: credentials.problems.join('; ') });
      return;
    }
    const client = clientFor(credentials, FAVORITE_PRESET);
    try {
      const nav = await getNav(client);
      const folders = await listFavoriteFolders(client, nav.mid);
      json(res, 200, {
        folders: folders.map(({ mediaId, title, count, isDefault }) => ({ mediaId, title, count, isDefault })),
      });
    } catch (error) {
      json(res, 400, { error: error instanceof BiliApiError ? `${error.code}: ${error.apiMessage}` : String(error.message) });
    }
    return;
  }

  if (route === '/api/plan' && req.method === 'GET') {
    const kind = url.searchParams.get('kind') === 'favorites' ? 'favorites' : 'unfollow';
    try {
      json(res, 200, planPayload(planFor(kind, loadCredentials())));
    } catch (error) {
      json(res, 400, { error: String(error.message) });
    }
    return;
  }

  if (route === '/api/execute' && req.method === 'POST') {
    const body = await readBody(req);
    const kind = body.kind === 'favorites' ? 'favorites' : 'unfollow';

    let plan;
    try {
      plan = planFor(kind, loadCredentials());
    } catch (error) {
      json(res, 400, { error: String(error.message) });
      return;
    }

    // The token gate is the same one the CLI uses: a plan that changed since it
    // was displayed cannot be executed with the stale token.
    if (body.token !== plan.run.token) {
      json(res, 409, {
        error: 'the plan changed since it was shown. Review it again and confirm the new token.',
        token: plan.run.token,
      });
      return;
    }

    const credentials = loadCredentials();
    if (!credentials.writable) {
      json(res, 400, { error: 'biliJct is required to execute' });
      return;
    }
    if (plan.run.actions.length === 0) {
      json(res, 400, { error: 'nothing to do' });
      return;
    }

    const preset = kind === 'unfollow' ? UNFOLLOW_PRESET : FAVORITE_PRESET;
    const client = clientFor(credentials, preset);
    const startedAt = new Date();
    const logFile = path.join(
      LOG_DIR, `${kind === 'unfollow' ? 'unfollow' : 'favorites'}-${startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`,
    );
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const lines = [];
    lines.push(JSON.stringify({
      ts: startedAt.toISOString(),
      kind: 'header',
      action: kind === 'unfollow' ? 'unfollow' : 'favorites',
      source: 'gui',
      token: plan.run.token,
      cap: String(plan.settings[kind].freshCapDays),
      planned: plan.run.actions.length,
      mediaId: kind === 'favorites' ? plan.snapshot.mediaId : undefined,
      folderTitle: kind === 'favorites' ? plan.snapshot.title : undefined,
      snapshot: plan.snapshot.file,
    }));

    const onRecord = (record) => lines.push(JSON.stringify({ ts: new Date().toISOString(), ...record }));

    let summary;
    if (kind === 'unfollow') {
      summary = await executeUnfollow({
        client, actions: plan.run.actions, csrf: credentials.biliJct, onRecord,
      });
    } else {
      summary = await executeFavorites({
        client,
        mediaId: plan.snapshot.mediaId,
        actions: plan.run.actions,
        csrf: credentials.biliJct,
        onRecord,
      });
    }

    lines.push(JSON.stringify({
      ts: new Date().toISOString(),
      kind: 'summary',
      ok: summary.ok,
      failed: summary.failed,
      aborted: summary.aborted,
    }));
    fs.writeFileSync(logFile, `${lines.join('\n')}\n`, 'utf8');

    json(res, 200, {
      ok: summary.ok,
      failed: summary.failed,
      aborted: summary.aborted,
      logFile,
      requests: client.stats.requestCount,
      retries: client.stats.retryCount,
      records: summary.records.map((record) => ({
        id: record.mid ?? record.id,
        label: record.uname ?? record.title,
        ok: record.ok,
        code: record.code,
      })),
    });
    return;
  }

  if (route === '/api/schedule' && req.method === 'POST') {
    const body = await readBody(req);
    const settings = loadSettings();
    const time = String(body.time ?? settings.schedule.time);

    try {
      if (body.action === 'install') {
        const result = installDailyTask({ time, projectDir: process.cwd() });
        settings.schedule = { enabled: true, time };
        saveSettings(settings);
        json(res, 200, { installed: true, ...result, task: dailyTaskStatus() });
      } else {
        removeDailyTask();
        settings.schedule = { ...settings.schedule, enabled: false };
        saveSettings(settings);
        json(res, 200, { installed: false, task: dailyTaskStatus() });
      }
    } catch (error) {
      json(res, 400, { error: String(error.message) });
    }
    return;
  }

  json(res, 404, { error: 'unknown endpoint' });
}

function page(token) {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'gui', 'index.html'), 'utf8');
  return html.replace('__SESSION_TOKEN__', token);
}

async function main() {
  const portArg = process.argv.slice(2).find((arg) => arg.startsWith('--port='));
  const port = portArg ? Number(portArg.slice('--port='.length)) : DEFAULT_PORT;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new RangeError('--port must be a valid port');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    handle(req, res, url).catch((error) => {
      try {
        json(res, 500, { error: String(error?.message ?? error) });
      } catch {
        res.end();
      }
    });
  });

  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  console.log(`bili-purge control panel: http://127.0.0.1:${actual}`);
  console.log('bound to 127.0.0.1 only; press Ctrl+C to stop.');
}

runMain(import.meta.url, main);
