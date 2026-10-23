import { LLM_PROVIDER_CHAIN } from "./llm";

/**
 * "Verify" on the Settings page: one real request per provider, no guesses.
 *
 * These probes deliberately do NOT use the pipeline's own code paths, because the
 * question being answered is "does this credential work" - not "can ClipCraft
 * produce a transcript". Every result carries a human-readable `message` and the
 * `httpStatus` so the UI can explain the difference between a wrong key, an empty
 * quota and a machine with no internet.
 */

const VERIFY_TIMEOUT_MS = 15_000;

export type VerifyStatus =
  | "ok"
  | "rejected"
  | "limited"
  | "unreachable"
  | "error";

export type StockVerifyTarget = "pexels" | "pixabay" | "unsplash";

/** Key-free sources for named entities: only the connection is tested. */
export type EntityVerifyTarget = "wikimedia" | "openverse";

export interface VerifyProbeResult {
  target: "gemini" | "deepgram" | StockVerifyTarget | EntityVerifyTarget;
  status: VerifyStatus;
  label: string;
  message: string;
  /** Set when the probe could measure it. */
  latencyMs?: number;
  httpStatus?: number;
  /** For Gemini: how many models the key can see, and whether the chain's models are among them. */
  models?: string[];
  /** Extra rows the UI shows as-is (e.g. missing model ids). */
  notes?: string[];
}

function classifyStatus(status: number): VerifyStatus {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "rejected";
  if (status === 429) return "limited";
  if (status === 404) return "error";
  return "error";
}

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    // Keeps a dead VPN or a blocked firewall from hanging the Settings page.
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as {
      error?: string | { message?: string };
      message?: string;
    };
    const detail =
      (typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error === "object"
          ? parsed.error?.message
          : undefined) ??
      parsed.message ??
      "";
    return detail ? detail.slice(0, 240) : "";
  } catch {
    return "";
  }
}

/**
 * Google AI Studio: `GET /v1beta/models` proves the key is accepted and shows which
 * models it can call. When `withGeneration` is set, one 8-token completion proves the
 * billing/quota path works too (a key can list models and still be out of daily
 * requests) - that call is charged as free-tier traffic and returns almost immediately.
 */
export async function verifyGeminiKey(
  apiKey: string,
  options: {
    model?: string;
    withGeneration?: boolean;
    withVision?: boolean;
  } = {},
): Promise<VerifyProbeResult> {
  const model =
    options.model?.trim() || LLM_PROVIDER_CHAIN[0]?.model || "gemini-3.8-flash";
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      {
        method: "GET",
        headers: { "x-goog-api-key": apiKey, accept: "application/json" },
      },
    );
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const status = classifyStatus(response.status);
      return {
        target: "gemini",
        status,
        label: `Google AI Studio · ${model}`,
        latencyMs,
        httpStatus: response.status,
        message:
          status === "rejected"
            ? "The key was rejected (401/403). Copy it again from AI Studio - keys are shown once."
            : status === "limited"
              ? "The key works but is rate limited right now (429). The pipeline falls back to the next key or model."
              : detail || `Google replied with HTTP ${response.status}.`,
        ...(detail ? { notes: [detail] } : {}),
      };
    }

    const payload = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    const models = (payload.models ?? [])
      .map((entry) => (entry.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);

    const chainModels = LLM_PROVIDER_CHAIN.map((entry) => entry.model);
    const missing = [...new Set(chainModels)].filter(
      (id) => models.length > 0 && !models.includes(id),
    );
    const notes: string[] = [];
    if (models.length)
      notes.push(`${models.length} models visible to this key`);
    if (missing.length) {
      notes.push(
        `Not available on this key: ${missing.join(", ")} - the chain skips them and uses the models that are.`,
      );
    }

    let generationMessage = "";
    if (options.withGeneration) {
      const generation = await pingGeminiGeneration(apiKey, model);
      if (generation.status !== "ok")
        return { ...generation, latencyMs: Date.now() - startedAt };
      generationMessage = "a 1-word completion came back";
    }

    // Vision is what B-roll verification needs; a key can answer text prompts and
    // still be refused for image input, so the two are probed separately.
    let visionMessage = "";
    if (options.withVision) {
      const vision = await pingGeminiVision(apiKey, model);
      if (vision.status !== "ok")
        return { ...vision, latencyMs: Date.now() - startedAt };
      visionMessage = "image input works";
    }

    return {
      target: "gemini",
      status: "ok",
      label: `Google AI Studio · ${model}`,
      latencyMs,
      httpStatus: response.status,
      message: [generationMessage, visionMessage].filter(Boolean).length
        ? `Key accepted; ${[generationMessage, visionMessage].filter(Boolean).join(", and ")}. ` +
          (visionMessage
            ? "B-roll can verify images with this key."
            : "Viral detection can use this key.")
        : models.includes(model)
          ? `Key accepted and ${model} is available. Viral detection can use this key.`
          : "Key accepted. The model list could not be read, so availability is unconfirmed.",
      ...(models.length ? { models: models.slice(0, 12) } : {}),
      ...(notes.length ? { notes } : {}),
    };
  } catch (error) {
    return unreachable(
      "gemini",
      `Google AI Studio · ${model}`,
      error,
      "https://generativelanguage.googleapis.com",
    );
  }
}

async function pingGeminiGeneration(
  apiKey: string,
  model: string,
): Promise<VerifyProbeResult> {
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "Reply with exactly: OK" }] },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 8 },
        }),
      },
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      return {
        target: "gemini",
        status: classifyStatus(response.status),
        label: `Google AI Studio · ${model}`,
        latencyMs,
        httpStatus: response.status,
        message:
          detail || `The test completion failed with HTTP ${response.status}.`,
      };
    }
    return {
      target: "gemini",
      status: "ok",
      label: `Google AI Studio · ${model}`,
      latencyMs,
      message: "completion ok",
    };
  } catch (error) {
    return unreachable(
      "gemini",
      `Google AI Studio · ${model}`,
      error,
      "https://generativelanguage.googleapis.com",
    );
  }
}

/**
 * The model id is not verified against an API (Deepgram has no stable public
 * model-list endpoint), so the probe only flags ids that are almost certainly typos -
 * an unusual id is still allowed, it just gets a note.
 */
const KNOWN_DEEPGRAM_MODELS = new Set([
  "nova-3",
  "nova-2",
  "nova",
  "enhanced",
  "base",
  "general",
  "whisper",
  "latest",
]);

export function isKnownDeepgramModel(model: string): boolean {
  const base = model.trim().toLowerCase().replace(/:.*$/, "");
  return (
    base.startsWith("nova") ||
    base.startsWith("whisper") ||
    KNOWN_DEEPGRAM_MODELS.has(base)
  );
}

/**
 * Deepgram: `GET /v1/auth/token` is the check Deepgram's own docs recommend for "does
 * this key work" - it answers for any key, at no cost, and needs no project scope.
 *
 * A management call (`/v1/manage/projects`) is kept as a fallback and only for the
 * project count, because that endpoint is where a key without admin scope gets a 401 or
 * a 404 that has nothing to do with the credential being valid.
 */
export async function verifyDeepgramKey(
  apiKey: string,
  model: string,
): Promise<VerifyProbeResult> {
  const startedAt = Date.now();
  const label = `Deepgram · ${model}`;
  const notes = isKnownDeepgramModel(model)
    ? []
    : [
        `Unknown model "${model}" - Deepgram will reject it at transcription time if the id is wrong.`,
      ];
  const headers = {
    Authorization: `Token ${apiKey}`,
    accept: "application/json",
  };

  let response: Response;
  try {
    response = await fetchWithTimeout(
      "https://api.deepgram.com/v1/auth/token",
      { method: "GET", headers },
    );
  } catch (error) {
    return unreachable("deepgram", label, error, "https://api.deepgram.com");
  }
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    if (classifyStatus(response.status) === "rejected") {
      return {
        target: "deepgram",
        status: "rejected",
        label,
        latencyMs,
        httpStatus: response.status,
        message:
          "Deepgram rejected this key (401/403). Keys live in the Deepgram console under API keys.",
        ...(detail
          ? { notes: [...notes, detail] }
          : notes.length
            ? { notes }
            : {}),
      };
    }

    // 404/5xx from the key check is an endpoint problem, so ask the account-level call
    // before saying anything about the key. If that one authenticates, the key is fine.
    const fallback = await probeProjects(apiKey);
    if (fallback?.ok) {
      return {
        target: "deepgram",
        status: "ok",
        label,
        latencyMs: Date.now() - startedAt,
        httpStatus: 200,
        message:
          fallback.projects === null
            ? "Key accepted by api.deepgram.com."
            : `Key accepted (${fallback.projects} project${fallback.projects === 1 ? "" : "s"} on this account).`,
        notes: [
          ...notes,
          `Skipped /v1/auth/token, which replied HTTP ${response.status}${detail ? ` (${detail})` : ""}.`,
        ],
      };
    }

    return {
      target: "deepgram",
      status: "error",
      label,
      latencyMs,
      httpStatus: response.status,
      message:
        `Deepgram's key check did not answer (HTTP ${response.status}${detail ? `: ${detail}` : ""}). ` +
        "This is not a verdict on your key - transcription may still work.",
      notes: [
        ...notes,
        "If a clip will not transcribe, the model id and the key scopes are the two things to check.",
      ],
    };
  }

  const payload = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const scopes = Array.isArray(payload?.scopes)
    ? payload.scopes.filter(
        (scope): scope is string => typeof scope === "string",
      )
    : [];
  const canTranscribe =
    scopes.length === 0 ||
    scopes.some((scope) => TRANSCRIPTION_SCOPES.has(scope));

  return {
    target: "deepgram",
    // An authenticating key with no usable scope is a real problem to surface here,
    // because the failure would otherwise show up later as a silent fallback to whisper.
    status: canTranscribe ? "ok" : "limited",
    label,
    latencyMs,
    httpStatus: response.status,
    message: canTranscribe
      ? scopes.length
        ? `Key accepted (scopes: ${scopes.join(", ")}).`
        : "Key accepted by api.deepgram.com."
      : "The key authenticates, but none of its scopes covers transcription.",
    ...(canTranscribe
      ? { notes: notes.length ? notes : undefined }
      : {
          notes: [
            ...notes,
            `Scopes reported: ${scopes.join(", ") || "none"}. A key needs ${[...TRANSCRIPTION_SCOPES].join(", ")} (or admin) to run /v1/listen.`,
          ],
        }),
  };
}

/** Returns null unless the projects call answered at all; used only as the second opinion. */
async function probeProjects(
  apiKey: string,
): Promise<{ ok: boolean; projects: number | null } | null> {
  try {
    const response = await fetchWithTimeout(
      "https://api.deepgram.com/v1/manage/projects",
      {
        method: "GET",
        headers: {
          Authorization: `Token ${apiKey}`,
          accept: "application/json",
        },
      },
    );
    if (!response.ok) return { ok: false, projects: null };
    const payload = (await response.json().catch(() => null)) as {
      results?: unknown[];
    } | null;
    return {
      ok: true,
      projects: Array.isArray(payload?.results) ? payload.results.length : null,
    };
  } catch {
    return null;
  }
}

/** Scopes Deepgram accepts on /v1/listen; `admin:all` covers everything. */
const TRANSCRIPTION_SCOPES = new Set([
  "admin:all",
  "usage:write",
  "scopes:member",
]);

/** Node hides the real reason ("ECONNRESET", "ENOTFOUND") in `error.cause`. */
function networkDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } })
    .cause;
  return cause?.code ?? cause?.message ?? error.message;
}

function unreachable(
  target: "gemini" | "deepgram" | StockVerifyTarget | EntityVerifyTarget,
  label: string,
  error: unknown,
  host: string,
): VerifyProbeResult {
  const message = networkDetail(error);
  const timeout = /abort|timeout/i.test(message);
  return {
    target,
    status: "unreachable",
    label,
    message: timeout
      ? `The request to ${host} timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s.`
      : `Could not reach ${host}: ${message}`,
  };
}

/**
 * A real image is sent, because Gemini models are not all multimodal: the text
 * completion can pass while `inline_data` is refused. A 1x1 white PNG is enough
 * to prove the path works and costs a handful of tokens.
 */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function pingGeminiVision(
  apiKey: string,
  model: string,
): Promise<VerifyProbeResult> {
  const startedAt = Date.now();
  const label = `Google AI Studio · ${model} (vision)`;
  try {
    const response = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: "Reply with exactly: OK" },
                {
                  inline_data: {
                    mime_type: "image/png",
                    data: TINY_PNG_BASE64,
                  },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 8 },
        }),
      },
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      return {
        target: "gemini",
        status: classifyStatus(response.status),
        label,
        latencyMs,
        httpStatus: response.status,
        message:
          response.status === 404
            ? `This model does not accept images (${model}). B-roll verification needs a vision model.`
            : detail || `The vision test failed with HTTP ${response.status}.`,
      };
    }
    return {
      target: "gemini",
      status: "ok",
      label,
      latencyMs,
      message: "vision ok",
    };
  } catch (error) {
    return unreachable(
      "gemini",
      label,
      error,
      "https://generativelanguage.googleapis.com",
    );
  }
}

/**
 * Stock providers. Each probe asks for the smallest possible page of landscape
 * photos, so it proves three things at once: the key is accepted, the endpoint is
 * reachable, and the account still has quota for B-roll.
 */
export async function verifyStockProvider(
  target: StockVerifyTarget,
  apiKey: string,
): Promise<VerifyProbeResult> {
  const label =
    target === "pexels"
      ? "Pexels"
      : target === "pixabay"
        ? "Pixabay"
        : "Unsplash";
  const startedAt = Date.now();

  const url =
    target === "pexels"
      ? "https://api.pexels.com/v1/search?query=city&per_page=1&orientation=landscape"
      : target === "pixabay"
        ? `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=city&image_type=photo&orientation=horizontal&per_page=3&safesearch=true`
        : "https://api.unsplash.com/photos?per_page=1";

  const headers: Record<string, string> = { accept: "application/json" };
  if (target === "pexels") headers.authorization = apiKey;
  if (target === "unsplash") headers.authorization = `Client-ID ${apiKey}`;

  try {
    const response = await fetchWithTimeout(url, { method: "GET", headers });
    const latencyMs = Date.now() - startedAt;
    const notes: string[] = [];

    // Quota information is the difference between "works" and "works for 3 more
    // requests", and every provider exposes it differently.
    const header = (name: string): string | null =>
      response.headers?.get?.(name) ?? null;
    const rateLimit =
      target === "pixabay" ? null : header("x-ratelimit-remaining");
    const rateLimitTotal =
      target === "pixabay" ? null : header("x-ratelimit-limit");
    if (rateLimit)
      notes.push(
        `${label} quota left in this window: ${rateLimit}${rateLimitTotal ? ` / ${rateLimitTotal}` : ""}`,
      );

    if (!response.ok) {
      const detail = await readErrorDetail(response);
      const status = classifyStatus(response.status);
      // Pixabay answers a bad key with 400 + "Invalid or missing API key"; only
      // 401/403 is ever worded as a rejected key.
      const rejected =
        status === "rejected" ||
        (target === "pixabay" &&
          response.status === 400 &&
          /invalid or missing api key/i.test(detail));
      return {
        target,
        status: rejected
          ? "rejected"
          : status === "limited"
            ? "limited"
            : "error",
        label,
        latencyMs,
        httpStatus: response.status,
        message: rejected
          ? "The key was rejected. Copy it again from the provider dashboard."
          : status === "limited"
            ? "The key works but the account is rate limited right now (429). B-roll falls through to the next provider."
            : `${label} answered HTTP ${response.status}. The endpoint is reachable, but the request failed.` +
              (detail ? ` Provider said: ${detail}` : ""),
        ...(detail ? { notes } : {}),
      };
    }

    const payload = (await response.json()) as {
      photos?: unknown[];
      hits?: unknown[];
      errors?: unknown;
    };
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      return {
        target,
        status: "error",
        label,
        latencyMs,
        httpStatus: response.status,
        message: `${label} reported an error for this key.`,
        notes: [JSON.stringify(payload.errors).slice(0, 200)],
      };
    }
    const count = Array.isArray(payload)
      ? payload.length
      : Array.isArray(payload.photos)
        ? payload.photos.length
        : Array.isArray(payload.hits)
          ? payload.hits.length
          : undefined;

    return {
      target,
      status: "ok",
      label,
      latencyMs,
      httpStatus: response.status,
      message:
        count === 0
          ? "Key accepted, but the test search found no photos."
          : `Key accepted; the test search returned ${count ?? "a"} landscape photo${count === 1 ? "" : "s"}.`,
      ...(notes.length ? { notes } : {}),
    };
  } catch (error) {
    const host =
      target === "pexels"
        ? "https://api.pexels.com"
        : target === "pixabay"
          ? "https://pixabay.com"
          : "https://api.unsplash.com";
    return unreachable(target, label, error, host);
  }
}

export function verifyTarget(
  target: StockVerifyTarget,
  key: string,
): Promise<VerifyProbeResult> {
  return verifyStockProvider(target, key);
}

const ENTITY_PROBE_HEADERS = {
  "user-agent": "clipcraft-local/0.1 (local video editor; connection check)",
  accept: "application/json",
};

/**
 * Wikimedia Commons: no key, so this proves the connection. The search API and the
 * image host are different hostnames and a network can block one of them, so both
 * are asked - downloads need the image host.
 */
export async function verifyWikimedia(): Promise<VerifyProbeResult> {
  const label = "Wikimedia Commons";
  const startedAt = Date.now();

  try {
    const api = await fetchWithTimeout(
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&meta=siteinfo",
      { method: "GET", headers: ENTITY_PROBE_HEADERS },
    );
    if (!api.ok) {
      return {
        target: "wikimedia",
        status: api.status === 429 ? "limited" : "error",
        label,
        latencyMs: Date.now() - startedAt,
        httpStatus: api.status,
        message: `Commons answered HTTP ${api.status}.`,
      };
    }
  } catch (error) {
    return {
      ...unreachable(
        "wikimedia",
        label,
        error,
        "https://commons.wikimedia.org",
      ),
      notes: [
        "If this network blocks Wikimedia, Openverse is used as the fallback for entity images.",
      ],
    };
  }

  try {
    const image = await fetchWithTimeout(
      "https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg",
      {
        method: "HEAD",
        headers: ENTITY_PROBE_HEADERS,
      },
    );
    const latencyMs = Date.now() - startedAt;
    if (!image.ok) {
      return {
        target: "wikimedia",
        status: "error",
        label,
        latencyMs,
        httpStatus: image.status,
        message: `The search works, but the image host (upload.wikimedia.org) answered HTTP ${image.status}.`,
      };
    }
    return {
      target: "wikimedia",
      status: "ok",
      label,
      latencyMs,
      httpStatus: image.status,
      message:
        "Commons search and the image host (upload.wikimedia.org) both answer.",
    };
  } catch (error) {
    return {
      ...unreachable("wikimedia", label, error, "https://upload.wikimedia.org"),
      message:
        "The Commons search works, but the image host is unreachable, so image downloads would fail.",
    };
  }
}

/** Openverse: one anonymous search. It counts against the small anonymous quota. */
export async function verifyOpenverse(): Promise<VerifyProbeResult> {
  const label = "Openverse";
  const startedAt = Date.now();
  try {
    const response = await fetchWithTimeout(
      "https://api.openverse.org/v1/images/?q=city&page_size=1",
      {
        method: "GET",
        headers: ENTITY_PROBE_HEADERS,
      },
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const limited = response.status === 429;
      return {
        target: "openverse",
        status: limited ? "limited" : "error",
        label,
        latencyMs,
        httpStatus: response.status,
        message: limited
          ? "Openverse is reachable, but the anonymous quota is used up right now (429). Try again later."
          : `Openverse answered HTTP ${response.status}.`,
      };
    }
    const payload = (await response.json().catch(() => null)) as {
      results?: unknown[];
    } | null;
    const count = Array.isArray(payload?.results) ? payload.results.length : 0;
    return {
      target: "openverse",
      status: "ok",
      label,
      latencyMs,
      httpStatus: response.status,
      message:
        count > 0
          ? "Openverse answers and the test search returned an image."
          : "Openverse answers, but the test search found nothing.",
      notes: [
        "Anonymous access has a small quota; this test used one request.",
      ],
    };
  } catch (error) {
    return unreachable("openverse", label, error, "https://api.openverse.org");
  }
}
