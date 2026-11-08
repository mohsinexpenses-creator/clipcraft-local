import { log } from "./logger";

/**
 * Wall-clock timing for a queue job.
 *
 * A stage is deliberately allowed to overlap another stage: render work becomes
 * concurrent in a few places, so summing stages is not a meaningful "job time".
 * `wallMs` is always the end-to-end elapsed time; the stage values identify the
 * longest contributors and remain useful when they run in parallel.
 */
export type JobTimingOutcome = "done" | "failed" | "cancelled";

export interface JobTimingStage {
  name: string;
  /** Accumulated elapsed time for every invocation of this named stage. */
  elapsedMs: number;
  /** Number of completed spans aggregated into `elapsedMs`. */
  count: number;
}

export interface JobTimingSummary {
  job: string;
  outcome: JobTimingOutcome;
  wallMs: number;
  stages: JobTimingStage[];
}

export interface JobTimerOptions {
  /** Stable, log-safe name such as `clip-render:clip_123`. */
  job: string;
  /** Injectable for deterministic unit tests. */
  now?: () => number;
}

/** Format a duration compactly enough for a one-line worker log summary. */
export function formatElapsedTime(elapsedMs: number): string {
  const safeMs = Math.max(0, Math.round(elapsedMs));
  if (safeMs < 1_000) return `${safeMs}ms`;
  if (safeMs < 60_000) return `${(safeMs / 1_000).toFixed(2)}s`;

  const minutes = Math.floor(safeMs / 60_000);
  const seconds = (safeMs - minutes * 60_000) / 1_000;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

/**
 * Formatting is exported separately so tests and future structured log sinks
 * can assert the exact stage summary without monkey-patching console methods.
 */
export function formatJobTimingSummary(summary: JobTimingSummary): string {
  const stages = summary.stages.length
    ? summary.stages
        .map(
          (stage) =>
            `${stage.name}=${formatElapsedTime(stage.elapsedMs)}` +
            (stage.count > 1 ? `×${stage.count}` : ""),
        )
        .join(", ")
    : "no measured stages";

  return (
    `[JOB-TIMING] job=${summary.job} outcome=${summary.outcome} ` +
    `wall=${formatElapsedTime(summary.wallMs)} wall_ms=${Math.max(0, Math.round(summary.wallMs))} ` +
    `stages: ${stages}`
  );
}

/**
 * Lightweight wall-clock tracker used by workers, with no persistence or
 * dependency overhead in the hot render path.
 */
export class JobTimer {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly activeStages = new Map<string, number>();
  private readonly stages = new Map<string, JobTimingStage>();

  constructor(private readonly options: JobTimerOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Start a named stage and return an idempotent completion callback. */
  start(name: string): () => void {
    if (this.activeStages.has(name)) {
      throw new Error(`Job timing stage is already active: ${name}`);
    }

    const startedAt = this.now();
    this.activeStages.set(name, startedAt);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.stop(name);
    };
  }

  /** Complete a previously started stage. Missing stages are intentionally a no-op. */
  stop(name: string): void {
    const startedAt = this.activeStages.get(name);
    if (startedAt === undefined) return;
    this.activeStages.delete(name);

    const existing = this.stages.get(name) ?? {
      name,
      elapsedMs: 0,
      count: 0,
    };
    existing.elapsedMs += Math.max(0, this.now() - startedAt);
    existing.count += 1;
    this.stages.set(name, existing);
  }

  /** Time a synchronous or asynchronous operation, including a thrown failure. */
  async measure<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
    const done = this.start(name);
    try {
      return await operation();
    } finally {
      done();
    }
  }

  /** Snapshot the timer and close any still-active stage at the supplied end time. */
  summary(outcome: JobTimingOutcome): JobTimingSummary {
    for (const name of [...this.activeStages.keys()]) this.stop(name);

    return {
      job: this.options.job,
      outcome,
      wallMs: Math.max(0, this.now() - this.startedAt),
      stages: [...this.stages.values()].sort((a, b) => b.elapsedMs - a.elapsedMs),
    };
  }

  /** Emit the stable, grep-friendly job-end timing summary. */
  logSummary(outcome: JobTimingOutcome): JobTimingSummary {
    const summary = this.summary(outcome);
    log.info(formatJobTimingSummary(summary));
    return summary;
  }
}
