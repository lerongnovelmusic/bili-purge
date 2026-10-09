import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadCredentials, describeCredentials, cookieHeader, fingerprint,
  writeCredentialsTemplate, CredentialsError,
} from '../src/auth.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bili-purge-auth-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

const SECRET = 'a-very-secret-sessdata-value-0123456789';
const JCT = 'b'.repeat(32);

test('a missing file reports the problem instead of throwing', () => {
  const file = path.join(tempDir(), 'nope.json');
  const credentials = loadCredentials({ file, sessdata: '', biliJct: '' });

  assert.equal(credentials.ok, false);
  assert.equal(credentials.source, 'none');
  assert.match(credentials.problems.join(' '), /no credentials file/);
});

test('an empty sessdata in an existing file is reported distinctly', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { sessdata: '', biliJct: '' });

  const credentials = loadCredentials({ file });
  assert.equal(credentials.ok, false);
  assert.match(credentials.problems.join(' '), /sessdata is empty/);
});

test('a filled file is accepted and read-only is allowed without biliJct', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { sessdata: SECRET, mid: 42 });

  const credentials = loadCredentials({ file });
  assert.equal(credentials.ok, true);
  assert.equal(credentials.mid, 42);
  assert.equal(credentials.sessdata, SECRET);
  // Read-only works; writes are still gated.
  assert.equal(credentials.writable, false);
  assert.match(credentials.warnings.join(' '), /biliJct/);
});

test('biliJct unlocks writable and is checked for length', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { sessdata: SECRET, biliJct: JCT });
  assert.equal(loadCredentials({ file }).writable, true);

  writeJson(file, { sessdata: SECRET, biliJct: 'short' });
  const short = loadCredentials({ file });
  assert.equal(short.writable, true);
  assert.match(short.warnings.join(' '), /32 characters/);
});

test('broken JSON is a hard error, not a silent fallback', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => loadCredentials({ file }), CredentialsError);
});

test('a JSON array is rejected', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, ['nope']);
  assert.throws(() => loadCredentials({ file }), CredentialsError);
});

test('a pasted "SESSDATA=..." or quoted value is cleaned up', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { sessdata: '  SESSDATA=abc123  ' });
  assert.equal(loadCredentials({ file }).sessdata, 'abc123');

  writeJson(file, { sessdata: '"quoted-value"' });
  assert.equal(loadCredentials({ file }).sessdata, 'quoted-value');
});

test('alternative key spellings are accepted', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { SESSDATA: SECRET, bili_jct: JCT });
  const credentials = loadCredentials({ file });
  assert.equal(credentials.sessdata, SECRET);
  assert.equal(credentials.biliJct, JCT);
});

test('the environment is used when there is no file', () => {
  const file = path.join(tempDir(), 'absent.json');
  const previous = { s: process.env.BILI_SESSDATA, j: process.env.BILI_JCT };
  process.env.BILI_SESSDATA = SECRET;
  process.env.BILI_JCT = JCT;
  try {
    const credentials = loadCredentials({ file });
    assert.equal(credentials.ok, true);
    assert.equal(credentials.source, 'environment');
    assert.equal(credentials.biliJct, JCT);
  } finally {
    if (previous.s === undefined) delete process.env.BILI_SESSDATA;
    else process.env.BILI_SESSDATA = previous.s;
    if (previous.j === undefined) delete process.env.BILI_JCT;
    else process.env.BILI_JCT = previous.j;
  }
});

test('explicit options beat both file and environment', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { sessdata: 'from-file', mid: 1 });
  const credentials = loadCredentials({ file, sessdata: 'from-option', mid: 9 });
  assert.equal(credentials.sessdata, 'from-option');
  assert.equal(credentials.mid, 9);
});

test('the description never leaks the secret', () => {
  const dir = tempDir();
  const file = path.join(dir, 'credentials.json');
  writeJson(file, { sessdata: SECRET, biliJct: JCT });

  const credentials = loadCredentials({ file });
  const text = describeCredentials(credentials).join('\n');

  assert.ok(!text.includes(SECRET), 'sessdata leaked into the description');
  assert.ok(!text.includes(JCT), 'biliJct leaked into the description');
  assert.match(text, /sessdata: present/);
  assert.match(text, new RegExp(`sha256:${fingerprint(SECRET)}`));
});

test('the fingerprint is stable and not the value', () => {
  assert.equal(fingerprint(SECRET), fingerprint(SECRET));
  assert.notEqual(fingerprint(SECRET), fingerprint(`${SECRET}x`));
  assert.ok(!fingerprint(SECRET).includes(SECRET));
  assert.equal(fingerprint(''), 'none');
});

test('the cookie header carries only what is present', () => {
  assert.equal(cookieHeader({ sessdata: 'S', biliJct: 'J' }), 'SESSDATA=S; bili_jct=J');
  assert.equal(cookieHeader({ sessdata: 'S', biliJct: '' }), 'SESSDATA=S');
});

test('the template is written once and never overwritten', () => {
  const file = path.join(tempDir(), 'nested', 'credentials.json');
  const first = writeCredentialsTemplate(file);
  assert.equal(first.created, true);
  assert.ok(fs.existsSync(file));

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.sessdata, '');
  assert.ok(parsed._comment);

  fs.writeFileSync(file, JSON.stringify({ sessdata: 'keep-me' }), 'utf8');
  const second = writeCredentialsTemplate(file);
  assert.equal(second.created, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessdata, 'keep-me');
});
