/**
 * Phase 1: every module-tagged log line carries the `[HH:MM:SS]` stamp.
 *
 * The LLM/AI/Deepgram/B-roll modules used bare `console.log("[Tag] ...")`, so
 * their lines were the only ones in a job log without a timestamp and could not
 * be lined up with the render steps around them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { log, logTimestampPrefix } from '../lib/logger';

const TIME = /^\[\d{2}:\d{2}:\d{2}\]$/;
const TIME_MS = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]$/;

/** Run `fn` with console.log/warn captured, returning the printed arguments. */
function capture(fn: () => void): { out: unknown[][]; err: unknown[][] } {
  const out: unknown[][] = [];
  const err: unknown[][] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => { out.push(args); };
  console.warn = (...args: unknown[]) => { err.push(args); };
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  return { out, err };
}

/** Convert captured console arguments into the single line a terminal shows. */
function line(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

test('every module tag is stamped on the first line', () => {
  const tags = [
    '[LLM]', '[AI]', '[Deepgram]', '[broll]', '[ASD-CACHE]', '[Upload]',
    '[worker]', '[profanity]', '[RENDER-DIAG]', '[CAMERA-PLAN]', '[CAMERA-QA]',
    '[BROLL-SYNC]',
  ];
  for (const tag of tags) {
    const { out } = capture(() => log.tagged(`${tag} something happened`));
    assert.equal(out.length, 1, `${tag} prints exactly one line`);
    const printed = line(out[0]);
    const [stamp, ...rest] = printed.split(' ');
    assert.match(stamp, TIME, `${tag} starts with [HH:MM:SS], got ${stamp}`);
    assert.match(rest.join(' '), new RegExp(`^\\${tag}`), `${tag} keeps its tag right after the stamp`);
  }
});

test('taggedWarn goes to stderr with the same stamp', () => {
  const { out, err } = capture(() => log.taggedWarn('[LLM] model failed'));
  assert.equal(out.length, 0, 'nothing on stdout');
  assert.equal(err.length, 1);
  assert.match(line(err[0]), /^\[\d{2}:\d{2}:\d{2}\] \[LLM\] model failed$/);
});

test('a multi-line payload is stamped on its first line only', () => {
  const payload = JSON.stringify({ hook_line: 'you are the cutest kid', moments: [1, 2, 3] });
  const { out } = capture(() => log.tagged('[AI] Raw response (gemini/3.8-flash):', payload));
  const printed = line(out[0]);
  assert.equal(printed.split('\n').length, 1, 'this payload is a single line');
  assert.match(printed, /^\[\d{2}:\d{2}:\d{2}\] \[AI\] Raw response/);

  // A genuinely multi-line body must not repeat the stamp on continuation lines.
  const multi = 'line one\nline two\nline three';
  const seen = capture(() => log.tagged('[AI] Raw response (gemini/3.8-flash):', multi));
  const all = line(seen.out[0]!);
  assert.equal(all.match(/\[\d{2}:\d{2}:\d{2}\]/g)?.length, 1, 'exactly one stamp in the whole payload');
  assert.ok(all.includes('line two'), 'the body is still printed');
});

test('LOG_TIMESTAMP_MS=1 adds .mmm and is off by default', () => {
  const previous = process.env.LOG_TIMESTAMP_MS;
  try {
    delete process.env.LOG_TIMESTAMP_MS;
    assert.match(logTimestampPrefix(new Date(2026, 0, 2, 3, 4, 5, 678)), TIME);
    assert.equal(logTimestampPrefix(new Date(2026, 0, 2, 3, 4, 5, 678)), '[03:04:05]');

    process.env.LOG_TIMESTAMP_MS = '1';
    assert.match(logTimestampPrefix(new Date(2026, 0, 2, 3, 4, 5, 678)), TIME_MS);
    assert.equal(logTimestampPrefix(new Date(2026, 0, 2, 3, 4, 5, 678)), '[03:04:05.678]');

    const { out } = capture(() => log.tagged('[LLM] with millis'));
    assert.match(line(out[0]), /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[LLM\] with millis$/);
  } finally {
    if (previous === undefined) delete process.env.LOG_TIMESTAMP_MS;
    else process.env.LOG_TIMESTAMP_MS = previous;
  }
});

test('no ANSI colour codes when the output is not a TTY', () => {
  // node:test runs with a pipe on stdout, so the logger must emit plain text.
  const { out } = capture(() => {
    log.tagged('[LLM] plain');
    log.info('info line');
  });
  for (const args of out) {
    const printed = line(args);
    assert.equal(printed.includes('\x1b['), false, `no escape sequences: ${JSON.stringify(printed)}`);
  }
  assert.match(line(out[1]), /^\[\d{2}:\d{2}:\d{2}\] info line$/);
});

test('the replaced modules really print through the stamped logger', async () => {
  // Structural check: these files must no longer call console.log/warn directly
  // with a bracketed tag, which is what made their lines unstamped.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    'lib/ai.ts', 'lib/llm.ts', 'lib/deepgram.ts', 'lib/broll/plan.ts', 'lib/broll/image.ts',
    'lib/profanity.ts', 'lib/upload.ts', 'lib/upload-session.ts',
    'worker/broll-job.ts', 'worker/runtime-settings.ts',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const bare = source.match(/console\.(log|warn|error)\(\s*[`'"]\[/g) ?? [];
    assert.equal(bare.length, 0, `${file} still uses a bare console call with a [Tag] message`);
    assert.match(source, /log\.tagged/, `${file} prints through log.tagged`);
  }
});
