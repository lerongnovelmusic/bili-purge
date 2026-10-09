/**
 * Credential loading.
 *
 * Two rules hold everywhere in this project:
 *   1. A cookie value is never printed, logged, or written to a snapshot.
 *   2. A credential is never accepted from an untrusted place -- only from the
 *      local credentials file declared here, or from the environment.
 *
 * Read-only work needs `sessdata` alone. `biliJct` is the CSRF token required by
 * write endpoints, so it is only *warned* about until a write step runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_CREDENTIALS_PATH = path.join(os.homedir(), '.bili-purge', 'credentials.json');

export class CredentialsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CredentialsError';
  }
}

function clean(value) {
  if (typeof value !== 'string') return '';
  // Tolerate a pasted "SESSDATA=..." or quoted value.
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  const withoutPrefix = trimmed.replace(/^(sessdata|bili_jct|biliJct)\s*=\s*/i, '');
  return withoutPrefix.trim();
}

/**
 * @param {{file?: string, sessdata?: string, biliJct?: string, mid?: number|string}} [options]
 * @returns {{sessdata: string, biliJct: string, mid: number|null, file: string|null,
 *            source: string, problems: string[], warnings: string[], ok: boolean, writable: boolean}}
 */
export function loadCredentials(options = {}) {
  const file = options.file ?? process.env.BILI_CREDENTIALS ?? DEFAULT_CREDENTIALS_PATH;
  const fileExists = fs.existsSync(file);

  let fromFile = {};
  if (fileExists) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      throw new CredentialsError(`credentials file is not valid JSON: ${file}\n  ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CredentialsError(`credentials file must contain a JSON object: ${file}`);
    }
    fromFile = parsed;
  }

  const sessdata = clean(options.sessdata ?? fromFile.sessdata ?? fromFile.SESSDATA
    ?? process.env.BILI_SESSDATA);
  const biliJct = clean(options.biliJct ?? fromFile.biliJct ?? fromFile.bili_jct
    ?? fromFile.csrf ?? process.env.BILI_JCT);

  const midRaw = options.mid ?? fromFile.mid ?? process.env.BILI_MID ?? null;
  const mid = midRaw === null || midRaw === '' || typeof midRaw === 'undefined' ? null : Number(midRaw);

  const problems = [];
  const warnings = [];

  if (!sessdata) {
    problems.push(fileExists
      ? `sessdata is empty in ${file}`
      : `no credentials file at ${file} and BILI_SESSDATA is not set`);
  }
  if (!biliJct) warnings.push('biliJct is not set -- fine for read-only, required before any write step');
  if (mid !== null && !Number.isFinite(mid)) problems.push(`mid is not a number: ${String(midRaw)}`);
  if (biliJct && biliJct.length !== 32) warnings.push(`biliJct is usually 32 characters, got ${biliJct.length}`);

  return {
    sessdata,
    biliJct,
    mid,
    file: fileExists ? file : null,
    source: fileExists ? 'file' : (sessdata ? 'environment' : 'none'),
    problems,
    warnings,
    ok: problems.length === 0,
    writable: problems.length === 0 && Boolean(biliJct),
  };
}

/** A stable, non-reversible way to confirm the same secret is being read. */
export function fingerprint(value) {
  if (!value) return 'none';
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

/**
 * Human-readable credential status that never contains a secret.
 * @returns {string[]} one line per field
 */
export function describeCredentials(credentials) {
  const line = (label, value) => (value
    ? `  ${label}: present (length ${value.length}, sha256:${fingerprint(value)})`
    : `  ${label}: MISSING`);
  return [
    line('sessdata', credentials.sessdata),
    line('biliJct', credentials.biliJct),
    `  mid: ${credentials.mid ?? 'will auto-detect from the API'}`,
    `  source: ${credentials.source}${credentials.file ? ` (${credentials.file})` : ''}`,
  ];
}

/** The Cookie header value used for API calls. */
export function cookieHeader(credentials) {
  const parts = [`SESSDATA=${credentials.sessdata}`];
  if (credentials.biliJct) parts.push(`bili_jct=${credentials.biliJct}`);
  return parts.join('; ');
}

/** Write the template a user is expected to fill in themselves. */
export function writeCredentialsTemplate(file = DEFAULT_CREDENTIALS_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return { file, created: false };
  const template = {
    _comment: 'Fill sessdata in yourself. Read-only needs sessdata only; biliJct is for write steps. Never commit this file.',
    _where: 'DevTools -> Application -> Cookies -> https://www.bilibili.com -> SESSDATA',
    sessdata: '',
    biliJct: '',
    mid: null,
  };
  fs.writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { file, created: true };
}
