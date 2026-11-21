/**
 * Minimal console logger for the worker and web processes.
 *
 * Design goals (per user request: logs were a wall of same-styled lines):
 *  - ANSI colours, but ONLY when stdout/stderr is a TTY and NO_COLOR is not set
 *    (logs piped to a file stay clean; Node >= 13 enables VT processing on the
 *    Windows console automatically, so ANSI is safe on Windows 10+).
 *  - One visual hierarchy:
 *      section()  job-level header with a rule (a new clip render started)
 *      step()     "Step 2/3 · ..." banner
 *      ok/warn/error/info  status lines with ✓/⚠/✖ markers
 *      detail()   dim, indented context lines (FFmpeg commands, URLs, paths)
 *
 * No dependencies.
 */

function supportsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== '0';
  return Boolean(process.stdout.isTTY || process.stderr.isTTY);
}

const hasColor = supportsColor();

const wrap =
  (code: string) =>
  (text: string): string =>
    hasColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const color = {
  reset: wrap('0'),
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

/** `LOG_TIMESTAMP_MS=1` adds a `.mmm` field, e.g. `[14:07:31.482]`. */
function stampsMilliseconds(): boolean {
  const raw = process.env.LOG_TIMESTAMP_MS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const base = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return stampsMilliseconds() ? `${base}.${String(d.getMilliseconds()).padStart(3, "0")}` : base;
}

const stamp = (): string => color.gray(`[${timestamp()}]`);

/**
 * A plain `[Tag] ...` line with the same `[HH:MM:SS]` stamp as `log.*`.
 *
 * This exists because the LLM/AI/Deepgram/B-roll modules used bare
 * `console.log("[LLM] ...")`, so their lines were the only ones in a job log
 * without a timestamp - impossible to line up with the render steps around
 * them. A multi-line payload (a raw JSON response, a prompt dump) is stamped
 * on its FIRST line only: repeating the stamp on continuation lines would
 * interleave badly with anything else writing to the console at the same time.
 */
function stamped(stream: "out" | "error", message: string, extra: unknown[]): void {
  const write = stream === "out" ? console.log : console.warn;
  write(stamp(), message, ...extra);
}

const INDENT = '  ';

export const log = {
  /** Plain informational line. */
  info(message: string): void {
    console.log(stamp(), message);
  },

  /** Success line with a green check. */
  ok(message: string): void {
    console.log(stamp(), INDENT, color.green('✓'), message);
  },

  /** Warning line with a yellow marker. */
  warn(message: string): void {
    console.warn(stamp(), INDENT, color.yellow('⚠'), color.yellow(message));
  },

  /** Error line with a red marker. */
  error(message: string): void {
    console.error(stamp(), INDENT, color.red('✖'), color.red(message));
  },

  /** Dim, indented context line - FFmpeg commands, URLs, paths, probe results. */
  detail(message: string): void {
    console.log(stamp(), INDENT, color.gray(message));
  },

  /** A step banner inside a job, e.g. "Step 2/3 · FFmpeg mirror + crop + colour". */
  step(title: string): void {
    console.log();
    console.log(stamp(), color.cyan(color.bold(`▶ ${title}`)));
  },

  /** A job-level section header with a rule line, e.g. when a render job starts. */
  section(title: string): void {
    const width = 66;
    const rule = color.gray('─'.repeat(Math.max(4, width - title.length)));
    console.log();
    console.log(stamp(), `${color.magenta(color.bold(title))} ${rule}`);
  },

  /**
   * A stamped line for module-tagged output: `log.info("[LLM] Trying ...")` and
   * `console.log("[LLM] Trying ...")` now produce the same `[HH:MM:SS] [LLM] ...`.
   * Extra arguments are passed through (e.g. a raw response body).
   */
  tagged(message: string, ...extra: unknown[]): void {
    stamped("out", message, extra);
  },

  /** Like `tagged`, on stderr - for `[Tag] ...` warnings that used console.warn. */
  taggedWarn(message: string, ...extra: unknown[]): void {
    stamped("error", message, extra);
  },
};

/** Returns the `[HH:MM:SS]` / `[HH:MM:SS.mmm]` prefix the logger prints, for tests. */
export function logTimestampPrefix(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const base = `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
  return `[${stampsMilliseconds() ? `${base}.${String(date.getMilliseconds()).padStart(3, "0")}` : base}]`;
}
