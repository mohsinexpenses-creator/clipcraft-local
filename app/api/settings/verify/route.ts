import { NextResponse } from 'next/server';
import { loadEffectiveSettings, maskSecret } from '@/lib/app-settings';
import { verifyDeepgramKey, verifyGeminiKey, type VerifyProbeResult } from '@/lib/settings-verify';
import { LLM_PROVIDER_CHAIN } from '@/lib/llm';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * POST /api/settings/verify   { target?, candidates?, withGeneration?, keyIndex? }
 *
 * Real requests against the providers, so "verified" means the credential works from
 * this machine right now - not that a string is the right length.
 *
 * `candidates` lets a key be tested before it is stored, which is what makes the
 * difference between "paste, test, save" and "save, break the pipeline, dig the old key
 * out of the env file". Responses carry masked keys only.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const candidates = (typeof body.candidates === 'object' && body.candidates !== null ? body.candidates : {}) as Record<string, unknown>;
    const target = String(body.target ?? 'all').trim();
    const withGeneration = body.withGeneration === true;
    const settings = await loadEffectiveSettings();

    const results: VerifyProbeResult[] = [];

    if (target === 'all' || target === 'gemini') {
      const candidate = typeof candidates.geminiApiKey === 'string' ? candidates.geminiApiKey.trim() : '';
      const keys = candidate
        ? [candidate]
        : settings.ai.geminiApiKeys.length
          ? settings.ai.geminiApiKeys
          : [];

      if (keys.length === 0) {
        results.push({
          target: 'gemini',
          status: 'error',
          label: 'Google AI Studio',
          message: 'No Gemini key to test - none is saved under Settings -> AI providers.',
          notes: ['Paste a key in the field first to test it before saving.'],
        });
      } else {
        const only = Number.isInteger(body.keyIndex) ? Number(body.keyIndex) : null;
        const selected = only === null ? keys.map((key, index) => ({ key, index })) : keys.map((key, index) => ({ key, index })).filter((entry) => entry.index === only);
        // Sequential on purpose: parallel probes against one free-tier quota simply
        // generate 429s, and a pool is usually one to five keys.
        for (const entry of selected) {
          const result = await verifyGeminiKey(entry.key, {
            ...(typeof candidates.model === 'string' ? { model: candidates.model } : {}),
            withGeneration,
          });
          results.push({ ...result, label: `${maskSecret(entry.key)} · ${result.label}` });
        }
      }
    }

    if (target === 'all' || target === 'deepgram') {
      const key =
        typeof candidates.deepgramApiKey === 'string' && candidates.deepgramApiKey.trim()
          ? candidates.deepgramApiKey.trim()
          : settings.ai.deepgramApiKey;
      const model =
        typeof candidates.deepgramModel === 'string' && candidates.deepgramModel.trim()
          ? candidates.deepgramModel.trim()
          : settings.ai.deepgramModel || 'nova-2';

      if (!key) {
        results.push({
          target: 'deepgram',
          status: 'error',
          label: 'Deepgram',
          message: 'No Deepgram key to test - cloud transcription is simply off, and local whisper.cpp is used instead.',
          notes: ['Set one only if you prefer cloud transcription; it is optional.'],
        });
      } else {
        results.push(await verifyDeepgramKey(key, model));
      }
    }

    const chainModel = LLM_PROVIDER_CHAIN[0]?.model ?? '';
    return NextResponse.json({
      results,
      checkedAt: new Date().toISOString(),
      // So the UI can say "tested against the model detection actually uses".
      firstChainModel: chainModel,
      providerChoice: settings.ai.transcriptionProvider,
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Verification could not run.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
