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

function timestamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const stamp = (): string => color.gray(`[${timestamp()}]`);

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
};
