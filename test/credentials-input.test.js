import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCredentialBlob, describeBlob } from '../src/credentials-input.js';

const SESS = 'abc%2Cdef123';
const JCT = 'deadbeefdeadbeefdeadbeefdeadbeef';

test('a bare cookie header is parsed', () => {
  const parsed = parseCredentialBlob(
    `SESSDATA=${SESS}; bili_jct=${JCT}; DedeUserID=256121920; buvid3=noise;`,
  );
  assert.equal(parsed.sessdata, 'abc,def123', 'percent-encoding is decoded');
  assert.equal(parsed.biliJct, JCT);
  assert.equal(parsed.mid, '256121920');
  assert.equal(parsed.shape, 'cookie');
});

test('a "Cookie:" prefix is tolerated', () => {
  const parsed = parseCredentialBlob(`Cookie: SESSDATA=${SESS}; bili_jct=${JCT}`);
  assert.equal(parsed.biliJct, JCT);
});

test('a cURL command is recognised and parsed', () => {
  const parsed = parseCredentialBlob(
    `curl 'https://api.bilibili.com/x/relation/modify' -H 'Cookie: SESSDATA=${SESS}; bili_jct=${JCT}' --data 'fid=1'`,
  );
  assert.equal(parsed.shape, 'curl');
  assert.equal(parsed.sessdata, 'abc,def123');
  assert.equal(parsed.biliJct, JCT);
});

test('a JSON object works too', () => {
  const parsed = parseCredentialBlob(`{"sessdata":"${SESS}","bili_jct":"${JCT}"}`);
  assert.equal(parsed.shape, 'json');
  assert.equal(parsed.biliJct, JCT);
});

test('extra whitespace and newlines do not matter', () => {
  const parsed = parseCredentialBlob(`  SESSDATA = ${SESS} ;\n  bili_jct = ${JCT}  `);
  assert.equal(parsed.sessdata, 'abc,def123');
  assert.equal(parsed.biliJct, JCT);
});

test('only what is needed is kept', () => {
  const parsed = parseCredentialBlob(`SESSDATA=${SESS}; bili_jct=${JCT}; buvid3=tracking; b_nut=1`);
  assert.deepEqual(Object.keys(parsed).sort(), ['biliJct', 'found', 'mid', 'sessdata', 'shape']);
  assert.ok(!JSON.stringify(parsed).includes('tracking'), 'unrelated cookies are dropped');
});

test('a realistic DevTools request-header bundle is parsed', () => {
  const parsed = parseCredentialBlob([
    'accept: application/json, text/plain, */*',
    'cookie: buvid3=ABC; b_nut=1; SESSDATA=' + SESS + '; bili_jct=' + JCT + '; DedeUserID=256121920',
    'referer: https://www.bilibili.com/',
  ].join('\n'));
  assert.equal(parsed.sessdata, 'abc,def123');
  assert.equal(parsed.biliJct, JCT);
  assert.equal(parsed.mid, '256121920');
});

test('a missing bili_jct is reported, not invented', () => {
  const parsed = parseCredentialBlob(`SESSDATA=${SESS}; buvid3=x`);
  assert.equal(parsed.sessdata, 'abc,def123');
  assert.equal(parsed.biliJct, '');
  assert.deepEqual(parsed.found, ['sessdata']);
});

test('a copied page URL yields nothing, because it cannot contain cookies', () => {
  const parsed = parseCredentialBlob('https://www.bilibili.com/?spm_id_from=333.1007');
  assert.equal(parsed.sessdata, '');
  assert.equal(parsed.biliJct, '');
  assert.deepEqual(parsed.found, []);
  assert.equal(parsed.shape, 'cookie');
});

test('garbage does not throw and yields nothing', () => {
  for (const junk of ['hello world', '{}', 'curl', '=', ';;;;', 'SESSDATA=']) {
    const parsed = parseCredentialBlob(junk);
    assert.equal(parsed.sessdata, '');
  }
});

test('non-string input is handled', () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(parseCredentialBlob(bad).sessdata, '');
  }
});

test('describeBlob never echoes a secret value', () => {
  const parsed = parseCredentialBlob(`SESSDATA=${SESS}; bili_jct=${JCT}`);
  const message = describeBlob(parsed);
  assert.ok(!message.includes(SESS), 'the session value must not be echoed');
  assert.ok(!message.includes(JCT), 'the csrf value must not be echoed');
  assert.match(message, /sessdata, biliJct/);
});

test('describeBlob names what is missing', () => {
  assert.match(describeBlob(parseCredentialBlob(`SESSDATA=${SESS}`)), /bili_jct/);
  assert.match(describeBlob(parseCredentialBlob('')), /Nothing pasted/);
});
