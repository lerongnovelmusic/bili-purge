/**
 * The shared execution loop for both write actions.
 *
 * Lives here rather than inside each CLI so the GUI and the command line cannot
 * drift apart: the abort-on-risk-control rule and the record shape are defined
 * exactly once.
 */
import { unfollow, removeFavoriteBatch } from './actions.js';
import { BiliApiError, RISK_CONTROL_CODES } from './http.js';

/** Turn a thrown error into a log record field set. */
function failureFields(error) {
  const code = error instanceof BiliApiError ? error.code : 'unknown';
  const message = error instanceof BiliApiError ? error.apiMessage : String(error?.message ?? error);
  return { ok: false, code, message };
}

export function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/**
 * Unfollow one account at a time.
 *
 * @param {object} options
 * @param {object} options.client
 * @param {Array} options.actions         items with {id, label, ageDays}
 * @param {string} options.csrf
 * @param {Function} [options.onRecord]   called per attempt with a log record
 * @returns {Promise<{records: Array, ok: number, failed: number, aborted: boolean}>}
 */
export async function executeUnfollow({ client, actions, csrf, onRecord = () => {} }) {
  const records = [];
  let aborted = false;

  for (const [index, item] of actions.entries()) {
    let record;
    try {
      await unfollow(client, { fid: item.id, csrf });
      record = {
        action: 'unfollow',
        mid: item.id,
        uname: item.label,
        ageDays: Math.round(item.ageDays),
        ok: true,
      };
    } catch (error) {
      record = {
        action: 'unfollow',
        mid: item.id,
        uname: item.label,
        ageDays: Math.round(item.ageDays),
        ...failureFields(error),
      };
    }

    record.position = index + 1;
    record.total = actions.length;
    records.push(record);
    onRecord(record);

    if (!record.ok && RISK_CONTROL_CODES.has(record.code)) {
      aborted = true;
      break;
    }
  }

  return summarise(records, aborted);
}

/**
 * Delete favourite entries in batches.
 *
 * A failed batch is recorded as failed for every member: the API does not
 * report per-resource results, so claiming which ones landed would be a guess,
 * and a guess here means restore might re-add something still present.
 *
 * @param {object} options
 * @param {object} options.client
 * @param {string|number} options.mediaId
 * @param {Array} options.actions         items with {id, label, raw:{type,bvid}}
 * @param {string} options.csrf
 * @param {number} [options.batchSize]
 * @param {Function} [options.onRecord]   called per ITEM (not per batch)
 * @param {Function} [options.onBatch]    called per batch for progress display
 */
export async function executeFavorites({
  client, mediaId, actions, csrf, batchSize = 20, onRecord = () => {}, onBatch = () => {},
}) {
  const records = [];
  const batches = chunk(actions, batchSize);
  let aborted = false;

  for (const [index, batch] of batches.entries()) {
    let outcome;
    try {
      await removeFavoriteBatch(client, { mediaId, resources: batch, csrf });
      outcome = { ok: true };
    } catch (error) {
      outcome = failureFields(error);
    }

    onBatch({ index: index + 1, total: batches.length, size: batch.length, ...outcome });

    for (const item of batch) {
      const record = {
        action: 'favorites',
        mediaId,
        id: item.id,
        type: Number(item.raw?.type ?? 0),
        bvid: item.raw?.bvid ?? '',
        title: item.label,
        ageDays: Math.round(item.ageDays),
        ...outcome,
      };
      records.push(record);
      onRecord(record);
    }

    if (!outcome.ok && RISK_CONTROL_CODES.has(outcome.code)) {
      aborted = true;
      break;
    }
  }

  return { ...summarise(records, aborted), batches: batches.length };
}

function summarise(records, aborted) {
  const ok = records.filter((record) => record.ok).length;
  return { records, ok, failed: records.length - ok, aborted };
}
