/**
 * The tiny HTTP surface the B-roll fetchers need, plus retry/rate-limit helpers.
 *
 * Everything here is injected into the providers rather than called directly, so
 * the provider logic is unit-tested with fake responses and never touches the
 * network in tests (`npm test` must stay offline).
 */

import { AppError } from "../errors";

export interface BrollHttpResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BrollRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type BrollFetch = (url: string, init?: BrollRequestInit) => Promise<BrollHttpResponse>;

/**
 * Wikimedia asks for a descriptive User-Agent and blocks the default one; the
 * stock APIs do not care but sending it everywhere is harmless.
 */
export const BROLL_USER_AGENT =
  "clipcraft-local/0.1 (local video editor; B-roll image fetcher)";

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

export const defaultBrollFetch: BrollFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: { "User-Agent": BROLL_USER_AGENT, ...(init?.headers ?? {}) },
    ...(init?.body ? { body: init.body } : {}),
    signal: init?.signal,
  });
  return response as unknown as BrollHttpResponse;
};

/**
 * URLs can carry a credential (Pixabay's API takes `?key=…`), and these URLs end up
 * in error details, plan notes and the UI. Redact anything that could be a secret
 * before a URL is ever put in a message.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const name of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|client|auth|sig/i.test(name)) {
        parsed.searchParams.set(name, 'redacted');
        changed = true;
      }
    }
    return changed ? parsed.toString() : url;
  } catch {
    return url.replace(/([?&](?:key|api_key|token|secret|client_id|signature)=)[^&]*/gi, '$1redacted');
  }
}

/** A non-2xx answer from a provider; `retryable` drives the backoff decision. */
export class BrollHttpError extends AppError {
  readonly statusCode: number;
  readonly retryable: boolean;

  constructor(message: string, options: { statusCode: number; retryable: boolean; details?: string }) {
    super(message, {
      status: 502,
      details: options.details,
      resolution: "The image provider did not answer. Retry the B-roll step.",
    });
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
  }
}

/** The provider said "slow down" or "out of quota" - move to the next one. */
export class ProviderQuotaError extends AppError {
  readonly provider: string;

  constructor(provider: string, detail: string) {
    super(`${provider} is rate-limited or out of quota.`, {
      status: 429,
      details: detail,
      resolution: `The next provider in the order is used instead. Check the ${provider} quota in Settings.`,
    });
    this.provider = provider;
  }
}

/** The provider rejected the key (401/403). Only this is ever worded as a key problem. */
export class ProviderKeyError extends AppError {
  readonly provider: string;

  constructor(provider: string, detail: string) {
    super(`${provider} rejected the API key.`, {
      status: 401,
      details: detail,
      resolution: `Open Settings -> AI providers and test the ${provider} key.`,
    });
    this.provider = provider;
  }
}

export interface FetchJsonOptions {
  fetcher: BrollFetch;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Provider name used in error messages. */
  provider: string;
}

/** GET + JSON parse with a timeout; errors carry the provider name and status. */
export async function fetchJson(url: string, options: FetchJsonOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await options.fetcher(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderKeyError(options.provider, `HTTP ${response.status}`);
    }
    if (response.status === 429) {
      throw new ProviderQuotaError(options.provider, "HTTP 429");
    }
    if (!response.ok) {
      throw new BrollHttpError(`${options.provider} answered HTTP ${response.status}.`, {
        statusCode: response.status,
        retryable: response.status >= 500,
        details: redactUrl(url),
      });
    }
    try {
      return await response.json();
    } catch {
      throw new BrollHttpError(`${options.provider} returned invalid JSON.`, {
        statusCode: response.status,
        retryable: false,
        details: redactUrl(url),
      });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const aborted = controller.signal.aborted;
    throw new BrollHttpError(
      aborted ? `${options.provider} timed out.` : `${options.provider} could not be reached.`,
      { statusCode: 0, retryable: true, details: redactUrl(message) }
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Byte download with the same rules as `fetchJson`. */
export async function fetchBytes(
  url: string,
  options: FetchJsonOptions
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await options.fetcher(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    if (response.status === 429) throw new ProviderQuotaError(options.provider, "HTTP 429");
    if (!response.ok) {
      throw new BrollHttpError(`${options.provider} answered HTTP ${response.status}.`, {
        statusCode: response.status,
        retryable: response.status >= 500,
        details: redactUrl(url),
      });
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new BrollHttpError(
      controller.signal.aborted ? `${options.provider} timed out.` : `${options.provider} could not be reached.`,
      { statusCode: 0, retryable: true, details: redactUrl(message) }
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Bounded retries with exponential backoff. `sleep` is injectable so tests never
 * actually wait; the worker uses real timers.
 */
export async function withRetries<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastError: unknown;

  for (let attempt = 0; attempt < Math.max(1, options.attempts); attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const isLast = attempt === Math.max(1, options.attempts) - 1;
      if (isLast || !shouldRetry(error)) break;
      const delay = options.baseDelayMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Serialises provider calls with a minimum spacing. Wikimedia explicitly asks
 * clients not to hammer the API, and the free stock tiers are rate-limited too.
 */
export function createRateLimiter(options: {
  minIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): <T>(task: () => Promise<T>) => Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let nextAt = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = nextAt - now();
      if (wait > 0) await sleep(wait);
      nextAt = now() + options.minIntervalMs;
      return task();
    });
    // Keep the chain alive even when a task rejects.
    chain = run.catch(() => undefined);
    return run;
  };
}
