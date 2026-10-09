/**
 * QR-code login.
 *
 * The user scans a QR with the Bilibili app, exactly as they would on a new
 * device, and the cookies come back through the same channel the website uses.
 * Nothing is read out of the browser: SESSDATA and bili_jct are HttpOnly, so
 * no page script can see them, and they are never part of a URL.
 *
 * Flow:
 *   1. generate()  -> { url, qrcodeKey }   render `url` as a QR
 *   2. poll()      -> 86101 waiting / 86038 expired / 86090 scanned / 0 done
 *   3. on 0, the response's Set-Cookie headers carry the credentials
 */
import { buildUrl } from './http.js';

const PASSPORT = 'https://passport.bilibili.com';

/** Poll result codes returned in the payload's `code` field. */
export const QR_STATUS = {
  0: 'success',
  86038: 'expired',
  86090: 'scanned',
  86101: 'waiting',
};

/** Parse one Set-Cookie header line into a name/value pair. */
export function parseSetCookie(line) {
  if (typeof line !== 'string' || line === '') return null;
  const pair = line.split(';')[0];
  const index = pair.indexOf('=');
  if (index <= 0) return null;
  return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim() };
}

/**
 * Pull the credentials out of a set of Set-Cookie lines.
 *
 * Node exposes these as an array via `getSetCookie()`. Older runtimes only
 * offer the folded `set-cookie` string, so both shapes are accepted.
 */
export function cookiesFromSetCookie(input) {
  let lines;
  if (Array.isArray(input)) {
    lines = input;
  } else if (typeof input === 'string') {
    lines = input.split(/,(?=[^;=]+=)/);
  } else {
    return {};
  }

  const found = {};
  for (const line of lines) {
    const parsed = parseSetCookie(line);
    if (!parsed) continue;
    const key = parsed.name.toLowerCase();
    if (key === 'sessdata') found.sessdata = parsed.value;
    else if (key === 'bili_jct') found.biliJct = parsed.value;
    else if (key === 'dedeuserid') found.mid = parsed.value;
  }
  return found;
}

/** Set-Cookie headers from a Fetch API Headers object, as an array. */
export function setCookieLines(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const folded = headers.get?.('set-cookie');
  return folded ? [folded] : [];
}

/**
 * Some poll responses hand the credentials back in a cross-domain URL's query
 * string instead of a cookie header. This is the documented fallback.
 */
export function credentialsFromRedirect(url) {
  if (typeof url !== 'string' || url === '') return {};
  try {
    const parsed = new URL(url);
    const found = {};
    for (const [key, value] of parsed.searchParams) {
      const lower = key.toLowerCase();
      if (lower === 'sessdata') found.sessdata = value;
      else if (lower === 'bili_jct') found.biliJct = value;
      else if (lower === 'dedeuserid') found.mid = value;
    }
    return found;
  } catch {
    return {};
  }
}

/** Request a fresh QR code. */
export async function generateQr(client) {
  const data = await client.get(buildUrl(
    '/x/passport-login/web/qrcode/generate', {}, PASSPORT,
  ));
  if (!data?.qrcode_key || !data?.url) {
    throw new Error('the QR endpoint did not return a qrcode_key and url');
  }
  return { url: data.url, qrcodeKey: data.qrcode_key };
}

/**
 * Poll once. Never throws on a business code, because "not scanned yet" is the
 * normal state for most of the code's life.
 * @returns {{status: string, code: number, credentials: object, redirect?: string}}
 */
export async function pollQr(client, qrcodeKey) {
  const { payload, headers } = await client.getRaw(buildUrl(
    '/x/passport-login/web/qrcode/poll', { qrcode_key: qrcodeKey }, PASSPORT,
  ));

  const data = payload?.data ?? {};
  const code = Number(data.code);
  const status = QR_STATUS[code] ?? 'unknown';

  let credentials = {};
  if (status === 'success') {
    credentials = cookiesFromSetCookie(setCookieLines(headers));
    if (!credentials.sessdata || !credentials.biliJct) {
      // Fall back to the cross-domain URL, which also carries the values.
      credentials = { ...credentialsFromRedirect(data.url), ...credentials };
    }
  }

  return { status, code, credentials, redirect: data.url, message: data.message };
}

/**
 * Poll until the QR is scanned or expires.
 *
 * @param {object} client
 * @param {string} qrcodeKey
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  give up after this long (QR codes last ~180s)
 * @param {number} [opts.intervalMs]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.now]
 * @param {Function} [opts.onTick]   called with each poll result
 */
export async function waitForScan(client, qrcodeKey, opts = {}) {
  const {
    timeoutMs = 180_000,
    intervalMs = 2500,
    sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
    now = () => Date.now(),
    onTick = () => {},
  } = opts;

  const startedAt = now();
  let last = { status: 'waiting', code: 86101, credentials: {} };

  while (now() - startedAt < timeoutMs) {
    last = await pollQr(client, qrcodeKey);
    onTick(last);
    if (last.status === 'success' || last.status === 'expired') return last;
    await sleep(intervalMs);
  }

  return { ...last, status: 'timeout' };
}
