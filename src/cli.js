/**
 * Entry-point guard so a CLI module can be imported by tests without running.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isEntryPoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(importMetaUrl));
}

/**
 * Run `main` only when this module is the process entry point.
 *
 * A `main` that returns a number sets the exit code, which is how the daily
 * runner reports "stopped by risk control" to Task Scheduler. A returned
 * `undefined` leaves the exit code alone, so existing CLIs are unaffected.
 */
export function runMain(importMetaUrl, main, { onCredentialsError, onError } = {}) {
  if (!isEntryPoint(importMetaUrl)) return;
  Promise.resolve()
    .then(() => main())
    .then((result) => {
      if (typeof result === 'number') process.exitCode = result;
    })
    .catch((error) => {
      if (onCredentialsError?.(error)) return;
      if (onError) {
        onError(error);
        return;
      }
      console.error(`\nunexpected failure: ${error?.stack ?? error}`);
      process.exitCode = 1;
    });
}
