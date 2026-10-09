import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createClient, buildUrl, BiliApiError } from '../src/http.js';

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Run `fn` against a throwaway localhost server. */
async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

/** A client with no artificial delay, for tests that do not measure timing. */
function fastClient(overrides = {}) {
  return createClient({ minGapMs: 0, maxGapMs: 0, baseBackoffMs: 1, ...overrides });
}

test('a code 0 body is unwrapped to its data', async () => {
  await withServer((req, res) => json(res, { code: 0, data: { hello: 'world' } }), async (base) => {
    const data = await fastClient().get(`${base}/x`);
    assert.deepEqual(data, { hello: 'world' });
  });
});

test('a result-only body is unwrapped too', async () => {
  await withServer((req, res) => json(res, { code: 0, result: { n: 1 } }), async (base) => {
    assert.deepEqual(await fastClient().get(`${base}/x`), { n: 1 });
  });
});

test('a risk-control code is retried and then succeeds', async () => {
  let seen = 0;
  await withServer((req, res) => {
    seen += 1;
    if (seen === 1) json(res, { code: -509, message: 'too frequent' });
    else json(res, { code: 0, data: 'ok' });
  }, async (base) => {
    const client = fastClient();
    assert.equal(await client.get(`${base}/x`), 'ok');
    assert.equal(seen, 2);
    assert.equal(client.stats.retryCount, 1);
  });
});

test('a login failure is not retried', async () => {
  let seen = 0;
  await withServer((req, res) => {
    seen += 1;
    json(res, { code: -101, message: 'not logged in' });
  }, async (base) => {
    await assert.rejects(fastClient().get(`${base}/x`), (error) => {
      assert.ok(error instanceof BiliApiError);
      assert.equal(error.code, -101);
      return true;
    });
    assert.equal(seen, 1, 'a stale cookie must fail fast');
  });
});

test('an HTTP 500 is retried', async () => {
  let seen = 0;
  await withServer((req, res) => {
    seen += 1;
    if (seen === 1) json(res, { code: 0 }, 500);
    else json(res, { code: 0, data: 'recovered' });
  }, async (base) => {
    assert.equal(await fastClient().get(`${base}/x`), 'recovered');
    assert.equal(seen, 2);
  });
});

test('retries are bounded', async () => {
  let seen = 0;
  await withServer((req, res) => {
    seen += 1;
    json(res, { code: -412, message: 'intercepted' });
  }, async (base) => {
    await assert.rejects(fastClient({ maxRetries: 2 }).get(`${base}/x`), BiliApiError);
    assert.equal(seen, 3, 'expected the initial attempt plus two retries');
  });
});

test('a non-JSON body is a parse error, not a silent success', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>blocked</html>');
  }, async (base) => {
    await assert.rejects(fastClient().get(`${base}/x`), (error) => {
      assert.equal(error.code, 'parse');
      return true;
    });
  });
});

test('the cookie and browser-ish headers are sent', async () => {
  let headers = null;
  await withServer((req, res) => {
    headers = req.headers;
    json(res, { code: 0, data: 1 });
  }, async (base) => {
    await fastClient({ cookie: 'SESSDATA=abc; bili_jct=def' }).get(`${base}/x`);
  });

  assert.equal(headers.cookie, 'SESSDATA=abc; bili_jct=def');
  assert.match(headers['user-agent'], /Mozilla/);
  assert.equal(headers.referer, 'https://www.bilibili.com/');
});

test('no cookie header is sent when there is no cookie', async () => {
  let headers = null;
  await withServer((req, res) => {
    headers = req.headers;
    json(res, { code: 0, data: 1 });
  }, async (base) => {
    await fastClient().get(`${base}/x`);
  });
  assert.equal(headers.cookie, undefined);
});

test('requests are spaced by at least the configured gap', async () => {
  let seen = 0;
  await withServer((req, res) => {
    seen += 1;
    json(res, { code: 0, data: seen });
  }, async (base) => {
    const client = createClient({ minGapMs: 40, maxGapMs: 40 });
    const started = Date.now();
    await client.get(`${base}/a`);
    await client.get(`${base}/b`);
    await client.get(`${base}/c`);
    const elapsed = Date.now() - started;
    // Two gaps of 40ms between three requests.
    assert.ok(elapsed >= 70, `expected >= 70ms of spacing, got ${elapsed}ms`);
  });
  assert.equal(seen, 3);
});

test('buildUrl skips empty params and encodes the rest', () => {
  const url = new URL(buildUrl('/x/y', { a: 1, b: 'zh 中文', c: null, d: undefined }));
  assert.equal(url.pathname, '/x/y');
  assert.equal(url.searchParams.get('a'), '1');
  assert.equal(url.searchParams.get('b'), 'zh 中文');
  assert.equal(url.searchParams.has('c'), false);
  assert.equal(url.searchParams.has('d'), false);
});

test('buildUrl respects an absolute url and a custom base', () => {
  assert.equal(buildUrl('https://example.com/p', { q: 'x' }), 'https://example.com/p?q=x');
  assert.equal(new URL(buildUrl('/p', {}, 'https://api.test')).host, 'api.test');
});

test('a nonsensical gap configuration is rejected', () => {
  assert.throws(() => createClient({ minGapMs: 100, maxGapMs: 10 }), RangeError);
  assert.throws(() => createClient({ minGapMs: -1 }), RangeError);
});

test('a missing fetch implementation is rejected', () => {
  assert.throws(() => createClient({ fetchImpl: null }), TypeError);
});

test('network errors are retried then surfaced', async () => {
  let attempts = 0;
  const client = createClient({
    minGapMs: 0,
    maxGapMs: 0,
    baseBackoffMs: 1,
    maxRetries: 1,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('socket hang up');
    },
  });

  await assert.rejects(client.get('https://example.com/x'), (error) => {
    assert.equal(error.code, 'network');
    assert.match(error.message, /socket hang up/);
    return true;
  });
  assert.equal(attempts, 2);
});

// ------------------------------------------------------------- postForm
/** Capture the method, content-type, cookie and body of one request. */
function capture(record, body = { code: 0, data: 'ok' }) {
  return (req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      record.method = req.method;
      record.contentType = req.headers['content-type'];
      record.cookie = req.headers.cookie;
      record.body = raw;
      json(res, body);
    });
  };
}

test('postForm sends a form-encoded POST with the cookie', async () => {
  const record = {};
  await withServer(capture(record), async (base) => {
    const client = fastClient({ cookie: 'SESSDATA=abc; bili_jct=TOKEN' });
    await client.postForm(`${base}/x/relation/modify`, { fid: 546195, act: 2, csrf: 'TOKEN' });

    assert.equal(record.method, 'POST');
    assert.match(record.contentType, /application\/x-www-form-urlencoded/);
    assert.match(record.cookie, /bili_jct=TOKEN/);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(record.body)), {
      fid: '546195', act: '2', csrf: 'TOKEN',
    });
  });
});

test('postForm drops null and undefined parameters', async () => {
  const record = {};
  await withServer(capture(record), async (base) => {
    await fastClient().postForm(`${base}/x`, { a: 1, b: null, c: undefined, d: 0 });
    assert.deepEqual(Object.fromEntries(new URLSearchParams(record.body)), { a: '1', d: '0' });
  });
});

test('postForm returns the unwrapped payload', async () => {
  await withServer((req, res) => { req.resume(); req.on('end', () => json(res, { code: 0, data: { ok: 1 } })); },
    async (base) => {
      assert.deepEqual(await fastClient().postForm(`${base}/x`, {}), { ok: 1 });
    });
});

test('a write does NOT retry a risk-control refusal', async () => {
  // Retrying a mutation after a refusal is how accounts get locked.
  let seen = 0;
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen += 1;
      json(res, { code: -352, message: 'risk control' });
    });
  }, async (base) => {
    const client = fastClient();
    await assert.rejects(client.postForm(`${base}/x`, { csrf: 'T' }), (error) => {
      assert.equal(error.code, -352);
      return true;
    });
    assert.equal(seen, 1, 'exactly one attempt');
    assert.equal(client.stats.retryCount, 0);
  });
});

test('a write does NOT retry an HTTP error either', async () => {
  let seen = 0;
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => { seen += 1; json(res, { code: 0 }, 500); });
  }, async (base) => {
    await assert.rejects(fastClient().postForm(`${base}/x`, {}), (error) => {
      assert.equal(error.code, '500');
      return true;
    });
    assert.equal(seen, 1);
  });
});

test('a write DOES retry a network failure, because the endpoints are idempotent', async () => {
  let attempts = 0;
  const client = createClient({
    minGapMs: 0,
    maxGapMs: 0,
    baseBackoffMs: 1,
    maxRetries: 1,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error('socket hang up');
    },
  });

  await assert.rejects(client.postForm('https://example.com/x', { csrf: 'T' }), (error) => {
    assert.equal(error.code, 'network');
    return true;
  });
  assert.equal(attempts, 2);
});

test('a non-JSON write response is reported as a parse failure', async () => {
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>412</html>'); });
  }, async (base) => {
    await assert.rejects(fastClient().postForm(`${base}/x`, {}), (error) => {
      assert.equal(error.code, 'parse');
      return true;
    });
  });
});
