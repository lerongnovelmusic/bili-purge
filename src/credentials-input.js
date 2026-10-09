/**
 * Extract credentials from whatever the user pastes.
 *
 * Finding SESSDATA in a browser is the annoying part, so this accepts several
 * shapes and pulls the fields out itself:
 *
 *   - a bare Cookie header   SESSDATA=...; bili_jct=...; DedeUserID=...
 *   - the "Cookie:" line from DevTools
 *   - a "Copy as cURL" command (bash or cmd)
 *   - a JSON object
 *
 * Only the two values that matter are kept; everything else in the blob is
 * discarded rather than stored.
 *
 * Note on what CANNOT work: SESSDATA and bili_jct are HttpOnly cookies. No page
 * script can read them, and they are never present in a copied page URL, so
 * "paste the address bar" can never yield credentials.
 */

const KEYS = {
  sessdata: ['sessdata'],
  biliJct: ['bili_jct', 'bilijct'],
  mid: ['dedeuserid', 'dedeuserid__ckmd5', 'mid'],
};

/** Value of `name=` in a cookie-ish blob, up to a delimiter. */
function findValue(text, names) {
  for (const name of names) {
    // Loose on purpose. The blob may be a cookie header (`name=value`), a cURL
    // command with the bundle inside quotes, or JSON (`"name":"value"`), so the
    // separator may be '=' or ':', surrounded by whitespace or quotes.
    const pattern = new RegExp(
      `(?:^|[;\\s'"&?,])${name}["']?\\s*[=:]\\s*["']?([^;\\s'"&,}]+)`,
      'i',
    );
    const match = pattern.exec(text);
    if (match) return decodeURIComponent(match[1]);
  }
  return '';
}

/**
 * @param {string} text
 * @returns {{sessdata: string, biliJct: string, mid: string, found: string[], shape: string}}
 */
export function parseCredentialBlob(text) {
  const raw = typeof text === 'string' ? text : '';
  if (raw.trim() === '') {
    return { sessdata: '', biliJct: '', mid: '', found: [], shape: 'empty' };
  }

  let shape = 'cookie';
  if (/curl\s/i.test(raw)) shape = 'curl';
  else if (/^\s*[{[]/.test(raw)) shape = 'json';

  const sessdata = findValue(raw, KEYS.sessdata);
  const biliJct = findValue(raw, KEYS.biliJct);
  const mid = findValue(raw, KEYS.mid);

  const found = [];
  if (sessdata) found.push('sessdata');
  if (biliJct) found.push('biliJct');
  if (mid) found.push('mid');

  return { sessdata, biliJct, mid, found, shape };
}

/**
 * Human-readable verdict for a parsed blob, so the GUI can explain a failure
 * without ever echoing a secret value.
 */
export function describeBlob(parsed) {
  if (parsed.shape === 'empty') return 'Nothing pasted.';
  const missing = [];
  if (!parsed.sessdata) missing.push('SESSDATA');
  if (!parsed.biliJct) missing.push('bili_jct');
  if (missing.length === 0) return `Found ${parsed.found.join(', ')}.`;
  return `Could not find ${missing.join(' and ')} in what was pasted.`;
}
