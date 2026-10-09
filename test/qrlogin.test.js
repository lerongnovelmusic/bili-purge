import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSetCookie, cookiesFromSetCookie, credentialsFromRedirect,
  setCookieLines, generateQr, pollQr, waitForScan, QR_STATUS,
} from '../src/qrlogin.js';

// ------------------------------------------------------------- parsing
test('parseSetCookie keeps only the name and value', () => {
  assert.deepEqual(
    parseSetCookie('SESSDATA=abc123; Path=/; Domain=.bilibili.com; HttpOnly; Secure'),
    { name: 'SESSDATA', value: 'abc123' },
  );
});

test('parseSetCookie handles an awkward but legal value', () => {
  // Cookie values may contain '=' padding; only the first one separates.
  assert.deepEqual(parseSetCookie('bili_jct=aa==bb'), { name: 'bili_jct', value: 'aa==bb' });
});

test('parseSetCookie rejects junk', () => {
  for (const bad of ['', 'noequals', null, undefined, 42]) {
    assert.equal(parseSetCookie(bad), null);
  }
});

test('cookiesFromSetCookie picks out the three credentials', () => {
  const found = cookiesFromSetCookie([
    'SESSDATA=sess%2Cvalue; Path=/; HttpOnly',
    'bili_jct=csrfvalue; Path=/',
    'DedeUserID=256121920; Path=/',
    'buvid3=noise; Path=/',
  ]);
  assert.deepEqual(found, { sessdata: 'sess%2Cvalue', biliJct: 'csrfvalue', mid: '256121920' });
});

test('cookiesFromSetCookie is case-insensitive on the cookie name', () => {
  assert.deepEqual(cookiesFromSetCookie(['sessdata=x; Path=/']), { sessdata: 'x' });
});

test('cookiesFromSetCookie should not split on a comma inside a date', () => {
  // Expires=Wed, 21 Oct 2026 07:28:00 GMT contains a comma; naive splitting
  // would tear the header in half.
  const folded = 'SESSDATA=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, bili_jct=tok; Path=/';
  assert.deepEqual(cookiesFromSetCookie(folded), { sessdata: 'abc', biliJct: 'tok' });
});

test('cookiesFromSetCookie tolerates a missing or odd input', () => {
  assert.deepEqual(cookiesFromSetCookie(null), {});
  assert.deepEqual(cookiesFromSetCookie(undefined), {});
  assert.deepEqual(cookiesFromSetCookie(['nonsense']), {});
  assert.deepEqual(cookiesFromSetCookie([]), {});
});

test('credentialsFromRedirect reads the cross-domain fallback url', () => {
  const found = credentialsFromRedirect(
    'https://passport.biligame.com/crossDomain?DedeUserID=777&SESSDATA=s1&bili_jct=j1&gourl=x',
  );
  assert.deepEqual(found, { sessdata: 's1', biliJct: 'j1', mid: '777' });
});

test('credentialsFromRedirect ignores a url with nothing useful', () => {
  assert.deepEqual(credentialsFromRedirect('https://example.com/'), {});
  assert.deepEqual(credentialsFromRedirect('not a url'), {});
  assert.deepEqual(credentialsFromRedirect(''), {});
  assert.deepEqual(credentialsFromRedirect(null), {});
});

test('setCookieLines prefers getSetCookie and falls back to the folded header', () => {
  const modern = { getSetCookie: () => ['a=1', 'b=2'], get: () => 'a=1, b=2' };
  assert.deepEqual(setCookieLines(modern), ['a=1', 'b=2']);

  const legacy = { get: (name) => (name === 'set-cookie' ? 'a=1' : null) };
  assert.deepEqual(setCookieLines(legacy), ['a=1']);

  assert.deepEqual(setCookieLines(null), []);
  assert.deepEqual(setCookieLines({ get: () => null }), []);
});

// ------------------------------------------------------- generate / poll
function fakeClient({ get, getRaw }) {
  return { get, getRaw, async postForm() { throw new Error('not used'); }, stats: {} };
}

test('generateQr returns the key and the url to render', async () => {
  const client = fakeClient({
    get: async (url) => {
      assert.match(url, /qrcode\/generate/);
      return { qrcode_key: 'KEY123', url: 'https://account.bilibili.com/h5/...' };
    },
  });
  assert.deepEqual(await generateQr(client), {
    url: 'https://account.bilibili.com/h5/...', qrcodeKey: 'KEY123',
  });
});

test('generateQr refuses a malformed response', async () => {
  const client = fakeClient({ get: async () => ({}) });
  await assert.rejects(generateQr(client), /did not return/);
});

test('pollQr reports each state without throwing', async () => {
  const cases = [
    [86101, 'waiting'], [86090, 'scanned'], [86038, 'expired'],
  ];
  for (const [code, expected] of cases) {
    const client = fakeClient({
      getRaw: async () => ({ payload: { code: 0, data: { code, message: 'x' } }, headers: null }),
    });
    const result = await pollQr(client, 'KEY');
    assert.equal(result.status, expected);
    assert.equal(result.code, code);
    assert.deepEqual(result.credentials, {});
  }
});

test('QR_STATUS maps the documented codes and nothing else', () => {
  assert.equal(QR_STATUS[0], 'success');
  assert.equal(QR_STATUS[86101], 'waiting');
  assert.equal(QR_STATUS[99999], undefined);
});

test('pollQr extracts credentials from Set-Cookie on success', async () => {
  const headers = { getSetCookie: () => ['SESSDATA=s1; Path=/', 'bili_jct=j1; Path=/', 'DedeUserID=9; Path=/'] };
  const client = fakeClient({
    getRaw: async () => ({ payload: { code: 0, data: { code: 0 } }, headers }),
  });

  const result = await pollQr(client, 'KEY');
  assert.equal(result.status, 'success');
  assert.deepEqual(result.credentials, { sessdata: 's1', biliJct: 'j1', mid: '9' });
});

test('pollQr falls back to the redirect url when cookies are absent', async () => {
  // Cookies can be dropped by a proxy; the cross-domain url still carries them.
  const client = fakeClient({
    getRaw: async () => ({
      payload: { code: 0, data: { code: 0, url: 'https://x/crossDomain?SESSDATA=s2&bili_jct=j2' } },
      headers: null,
    }),
  });

  const result = await pollQr(client, 'KEY');
  assert.equal(result.status, 'success');
  assert.equal(result.credentials.sessdata, 's2');
  assert.equal(result.credentials.biliJct, 'j2');
});

test('pollQr prefers a real cookie over the redirect url', async () => {
  const headers = { getSetCookie: () => ['SESSDATA=fromcookie; Path=/', 'bili_jct=jc; Path=/'] };
  const client = fakeClient({
    getRaw: async () => ({
      payload: { code: 0, data: { code: 0, url: 'https://x/crossDomain?SESSDATA=fromurl&bili_jct=ju' } },
      headers,
    }),
  });

  const result = await pollQr(client, 'KEY');
  assert.equal(result.credentials.sessdata, 'fromcookie');
  assert.equal(result.credentials.biliJct, 'jc');
});

test('pollQr reports an unknown code instead of pretending', async () => {
  const client = fakeClient({
    getRaw: async () => ({ payload: { code: 0, data: { code: 12345 } }, headers: null }),
  });
  const result = await pollQr(client, 'KEY');
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 12345);
});

// ------------------------------------------------------------- waitForScan
test('waitForScan stops as soon as the scan succeeds', async () => {
  let calls = 0;
  const client = fakeClient({
    getRaw: async () => {
      calls += 1;
      if (calls < 3) return { payload: { code: 0, data: { code: 86101 } }, headers: null };
      return {
        payload: { code: 0, data: { code: 0 } },
        headers: { getSetCookie: () => ['SESSDATA=s; Path=/', 'bili_jct=j; Path=/'] },
      };
    },
  });

  const result = await waitForScan(client, 'KEY', { sleep: async () => {}, intervalMs: 0 });
  assert.equal(result.status, 'success');
  assert.equal(result.credentials.sessdata, 's');
  assert.equal(calls, 3);
});

test('waitForScan gives up when the QR expires', async () => {
  const client = fakeClient({
    getRaw: async () => ({ payload: { code: 0, data: { code: 86038 } }, headers: null }),
  });
  const result = await waitForScan(client, 'KEY', { sleep: async () => {}, intervalMs: 0 });
  assert.equal(result.status, 'expired');
});

test('waitForScan times out rather than polling forever', async () => {
  let fakeNow = 0;
  const client = fakeClient({
    getRaw: async () => {
      fakeNow += 60_000;
      return { payload: { code: 0, data: { code: 86101 } }, headers: null };
    },
  });

  const result = await waitForScan(client, 'KEY', {
    timeoutMs: 120_000, intervalMs: 0, sleep: async () => {}, now: () => fakeNow,
  });
  assert.equal(result.status, 'timeout');
});

test('waitForScan reports each tick to the caller', async () => {
  const seen = [];
  let calls = 0;
  const client = fakeClient({
    getRaw: async () => {
      calls += 1;
      if (calls === 1) return { payload: { code: 0, data: { code: 86101 } }, headers: null };
      return { payload: { code: 0, data: { code: 86101 } }, headers: null };
    },
  });

  await waitForScan(client, 'KEY', {
    timeoutMs: 5000, intervalMs: 0, sleep: async () => {}, onTick: (r) => seen.push(r.status),
  });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((status) => status === 'waiting'));
});
