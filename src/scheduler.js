/**
 * Windows Task Scheduler integration for the daily run.
 *
 * A scheduled task is the only way to truly "start once a day" without leaving
 * a process running. Two honest caveats are surfaced by `daily.js` rather than
 * hidden here:
 *
 *   1. The task runs whether or not you are watching, so the confirm-token gate
 *      cannot apply. Installing the task IS the authorisation, which is why it
 *      is an explicit, reversible action rather than a checkbox default.
 *   2. Cookies expire. When SESSDATA goes stale the run fails cleanly and says
 *      so in the log; it does not silently do nothing forever.
 *
 * `schtasks` is localised, so its output labels cannot be matched by name on a
 * non-English Windows. Everything below therefore reads the CSV format
 * positionally and decodes the console code page, which works in any locale.
 */
import { execFileSync } from 'node:child_process';

export const TASK_NAME = 'BiliPurgeDaily';

/**
 * Run schtasks and decode its output.
 *
 * On a Chinese Windows the console code page is GBK, so reading the bytes as
 * UTF-8 turns every label into mojibake. The GBK decoder is available because
 * Node ships with full ICU.
 */
function schtasks(args) {
  const buffer = execFileSync('schtasks', args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const encoding of ['gbk', 'utf-8']) {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(buffer);
    } catch {
      // Try the next candidate.
    }
  }
  return buffer.toString('utf8');
}

/** Split one CSV line, honouring quoted fields and doubled quotes. */
export function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Column positions in `schtasks /FO CSV /V`, which do not vary by locale. */
const COLUMN = {
  nextRunTime: 2,
  status: 3,
  lastRunTime: 5,
  lastResult: 6,
  taskToRun: 8,
  runAsUser: 14,
  scheduleTime: 19,
};

/** Map the placeholder that schtasks prints for "nothing" onto null. */
function clean(value) {
  const text = String(value ?? '').trim();
  if (text === '' || /^N\/A$/i.test(text)) return null;
  return text;
}

/**
 * Create or replace the daily task.
 * @param {{time: string, projectDir: string, script?: string, nodePath?: string}} options
 */
export function installDailyTask({ time, projectDir, script = 'daily.js', nodePath = process.execPath }) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time))) {
    throw new RangeError(`time must be HH:MM in 24-hour form, got "${time}"`);
  }

  const scriptPath = `${projectDir}\\${script}`;
  // schtasks parses this string itself, so the inner quotes are required even
  // though the argument is already quoted for CreateProcess.
  const command = `"${nodePath}" "${scriptPath}"`;

  schtasks([
    '/Create',
    '/TN', TASK_NAME,
    '/TR', command,
    '/SC', 'DAILY',
    '/ST', time,
    '/F',
  ]);

  return { taskName: TASK_NAME, time, command };
}

/** Current state of the task, as far as schtasks will tell us. */
export function dailyTaskStatus() {
  let output;
  try {
    output = schtasks(['/Query', '/TN', TASK_NAME, '/FO', 'CSV', '/V']);
  } catch {
    return { installed: false, taskName: TASK_NAME };
  }

  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return { installed: true, taskName: TASK_NAME };

  const row = parseCsvLine(lines[1]);
  return {
    installed: true,
    taskName: TASK_NAME,
    nextRunTime: clean(row[COLUMN.nextRunTime]),
    status: clean(row[COLUMN.status]),
    lastRunTime: clean(row[COLUMN.lastRunTime]),
    lastResult: clean(row[COLUMN.lastResult]),
    taskToRun: clean(row[COLUMN.taskToRun]),
    runAsUser: clean(row[COLUMN.runAsUser]),
    scheduleTime: clean(row[COLUMN.scheduleTime]),
  };
}

/**
 * Remove the task. Succeeds quietly when it does not exist.
 *
 * The failure message is localised, so instead of matching its text this
 * re-queries: if the task is gone, the delete did its job whatever it said.
 */
export function removeDailyTask() {
  try {
    schtasks(['/Delete', '/TN', TASK_NAME, '/F']);
    return { removed: true };
  } catch (error) {
    if (!dailyTaskStatus().installed) return { removed: false };
    const detail = String(error?.stderr ?? error?.message ?? '').trim();
    throw new Error(`could not remove the scheduled task: ${detail}`);
  }
}
