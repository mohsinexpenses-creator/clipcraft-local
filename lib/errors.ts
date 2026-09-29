import { loadEnvConfig } from '@next/env';

loadEnvConfig(process.cwd());

export interface AppErrorOptions {
  status?: number;
  details?: string;
  resolution?: string;
  cause?: unknown;
}

function getCauseMessage(cause: unknown): string | null {
  if (!cause) return null;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause.trim()) return cause.trim();

  try {
    const serialized = JSON.stringify(cause);
    return serialized === '{}' ? null : serialized;
  } catch {
    return null;
  }
}

function buildMessage(summary: string, options: AppErrorOptions = {}): string {
  const parts = [summary.trim()];

  if (options.details?.trim()) {
    parts.push(`Details: ${options.details.trim()}`);
  }

  const causeMessage = getCauseMessage(options.cause);
  if (causeMessage) {
    parts.push(`Cause: ${causeMessage}`);
  }

  if (options.resolution?.trim()) {
    parts.push(`How to fix: ${options.resolution.trim()}`);
  }

  return parts.join(' ');
}

export class AppError extends Error {
  public readonly status: number;
  public readonly summary: string;
  public readonly details?: string;
  public readonly resolution?: string;

  constructor(summary: string, options: AppErrorOptions = {}) {
    super(buildMessage(summary, options));
    this.name = 'AppError';
    this.status = options.status ?? 500;
    this.summary = summary;
    this.details = options.details;
    this.resolution = options.resolution;
  }
}

/**
 * Thrown (and caught) when the user cancels a running render. Unlike AppError
 * this is NOT a failure: the job ends cleanly, the clip is marked as cancelled
 * and the runner must not retry it.
 */
export class RenderCancelledError extends Error {
  constructor(message = 'Render cancelled by user.') {
    super(message);
    this.name = 'RenderCancelledError';
  }
}

/**
 * Route-handler error payload.
 *
 * The dashboard reads `data.error` (see getErrorFromResponse in app/page.tsx) while the
 * richer AppError fields are `summary` / `resolution`. Expose both `error` and `message`
 * so the real text reaches the UI instead of a generic fallback, and keep the
 * "How to fix" hint separate so it can be rendered as help text.
 */
export function getErrorResponse(error: unknown): {
  success: false;
  statusCode: number;
  error: string;
  message: string;
  resolution?: string;
  details?: string;
} {
  const statusCode = toErrorStatus(error);

  if (error instanceof AppError) {
    return {
      success: false,
      statusCode: error.status,
      error: error.summary,
      message: error.summary,
      ...(error.resolution ? { resolution: error.resolution } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }

  const message = toErrorMessage(error);
  return { success: false, statusCode, error: message, message };
}

export function toErrorMessage(error: unknown, fallback = 'An unexpected error occurred.'): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }

  return fallback;
}

export function toErrorStatus(error: unknown, fallback = 500): number {
  if (error instanceof AppError) {
    return error.status;
  }

  return fallback;
}

export function ensureEnvVar(name: string, purpose: string): string {
  const envName = name.trim().replace(/^\$\{?(.+?)\}?$/, '$1');
  const value =
    process.env[envName]?.trim() ??
    process.env[envName.toUpperCase()]?.trim();

  if (!value) {
    throw new AppError(`${envName} is not configured.`, {
      status: 500,
      resolution: `Set ${envName} in your .env.local file so ClipCraft can ${purpose}.`,
    });
  }

  if (value.toLowerCase().includes('your_api_key')) {
    throw new AppError(`${envName} is still using the placeholder value.`, {
      status: 500,
      resolution: `Replace ${envName} in .env.local with a real value so ClipCraft can ${purpose}.`,
    });
  }

  return value;
}
