/**
 * Rate-limited, retrying HTTP client for the Bilibili web API.
 *
 * Bilibili answers HTTP 200 even when it refuses a request; the real status
 * lives in the JSON `code` field. So the client has to look inside the body:
 *
 *    0        success
 *   -101      not logged in        -> fail fast, retrying will not help
 *   -352      risk control         -> back off and retry
 *   -412      request intercepted  -> back off and retry
 *   -509      too many requests    -> back off and retry
 *
 * Every request is spaced by a random gap so a run looks nothing like a burst.
 */

/**
 * Codes the API returns when it is refusing or throttling us. The read path
 * retries these; the write path aborts on them. Shared so the two paths can
 * never disagree about what a refusal looks like.
 */
export const RISK_CONTROL_CODES = new Set([-352, -412, -509, -799]);
const RETRYABLE_CODES = RISK_CONTROL_CODES;
const RETRYABLE_STATUS = new Set([412, 429, 500, 502, 503, 504]);

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
};

export class BiliApiError extends Error {
  constructor(code, message, details = {}) {
    super(`bilibili api error code=${code}${message ? `: ${message}` : ''}`);
    this.name = 'BiliApiError';
    this.code = code;
    this.apiMessage = message;
    this.url = details.url;
  }
}

/** Build an absolute API URL with query parameters, skipping null/undefined. */
export function buildUrl(path, params = {}, base = 'https://api.bilibili.com') {
  const url = new URL(path.startsWith('http') ? path : base + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {object} options
 * @param {string} [options.cookie]        Cookie header value
 * @param {number} [options.minGapMs]      shortest pause between requests
 * @param {number} [options.maxGapMs]      longest pause between requests
 * @param {number} [options.maxRetries]
 * @param {number} [options.baseBackoffMs]
 * @param {Function} [options.fetchImpl]   injectable for tests
 * @param {Function} [options.sleep]       injectable for tests
 * @param {Function} [options.random]      injectable for tests
 * @param {Function} [options.log]
 */
export function createClient(options = {}) {
  const {
    cookie = '',
    minGapMs = 1200,
    maxGapMs = 2600,
    maxRetries = 3,
    baseBackoffMs = 1500,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    random = Math.random,
    log = () => {},
  } = options;

  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (minGapMs < 0 || maxGapMs < minGapMs) throw new RangeError('require 0 <= minGapMs <= maxGapMs');

  let lastRequestAt = 0;
  let requestCount = 0;
  let retryCount = 0;

  async function throttle() {
    const gap = minGapMs + random() * (maxGapMs - minGapMs);
    const wait = lastRequestAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  /**
   * The one throttled fetch, shared by reads, writes and cookie-carrying flows.
   *
   * @param {string} url
   * @param {object} [opts]
   * @param {'GET'|'POST'} [opts.method]
   * @param {string|null} [opts.body]          form-encoded body for writes
   * @param {boolean} [opts.write]             a mutation: do NOT retry a refusal
   * @param {boolean} [opts.tolerate]          return a non-zero business code
   *                                           instead of throwing, for flows
   *                                           where "not yet" is a normal state
   */
  async function fetchJson(url, { method = 'GET', body = null, write = false, tolerate = false } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      await throttle();
      requestCount += 1;

      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers: {
            ...DEFAULT_HEADERS,
            ...(body === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          ...(body === null ? {} : { body }),
          redirect: 'follow',
        });
      } catch (error) {
        // A write may or may not have landed, but these endpoints are
        // idempotent, so retrying a transport failure is safe.
        if (attempt >= maxRetries) throw new BiliApiError('network', error.message, { url });
        retryCount += 1;
        await sleep(baseBackoffMs * 2 ** attempt);
        continue;
      }

      if (!response.ok) {
        if (!write && RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
          retryCount += 1;
          log(`  HTTP ${response.status} -- backing off`);
          await sleep(baseBackoffMs * 2 ** attempt);
          continue;
        }
        throw new BiliApiError(String(response.status), `HTTP ${response.status}`, { url });
      }

      let parsed;
      try {
        parsed = await response.json();
      } catch {
        throw new BiliApiError('parse', 'response body was not JSON', { url });
      }

      if (parsed && parsed.code === 0) return { response, payload: parsed };
      if (tolerate) return { response, payload: parsed };

      const code = parsed?.code ?? 'unknown';
      const message = parsed?.message ?? '';
      if (!write && RETRYABLE_CODES.has(code) && attempt < maxRetries) {
        retryCount += 1;
        log(`  code=${code} ${message} -- backing off`);
        await sleep(baseBackoffMs * 2 ** attempt);
        continue;
      }
      throw new BiliApiError(code, message, { url });
    }
  }

  async function request(url) {
    const { payload } = await fetchJson(url);
    return payload.data ?? payload.result ?? payload;
  }

  /**
   * Fetch without treating a non-zero business code as an error, and keep the
   * response headers. QR-login polling needs both: "未扫码" arrives as a normal
   * code, and the cookies on success arrive as Set-Cookie headers.
   */
  async function getRaw(url) {
    const { response, payload } = await fetchJson(url, { tolerate: true });
    return { payload, headers: response.headers };
  }

  /**
   * POST a form-encoded write request.
   *
   * Writes deliberately do NOT retry a risk-control response. A refusal means
   * the account is already being throttled, and pushing harder is exactly how
   * an account gets locked; the run should stop and let a human decide.
   *
   * Network failures ARE retried, because these endpoints are idempotent
   * (unfollowing twice, or deleting an already-deleted entry, is harmless).
   */
  async function postForm(url, params) {
    const body = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value !== undefined && value !== null),
    ).toString();

    const { payload } = await fetchJson(url, { method: 'POST', body, write: true });
    return payload.data ?? payload.result ?? payload;
  }

  return {
    get: request,
    getRaw,
    postForm,
    get stats() {
      return { requestCount, retryCount };
    },
  };
}
