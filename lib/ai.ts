import { AppError } from './errors';
import {
  detectViralSegments as detectWithClaude,
  generateCtaText as generateCtaWithClaude,
  generateHookText as generateHookWithClaude,
} from './claude';
import {
  detectViralSegments as detectWithGemini,
  generateCtaText as generateCtaWithGemini,
  generateHookText as generateHookWithGemini,
} from './gemini';
import { TranscriptData, ViralSegment } from './types';

export type AiProvider = 'gemini' | 'anthropic';

function hasConfiguredValue(name: string): boolean {
  const value = process.env[name]?.trim();
  return Boolean(value && !value.toLowerCase().includes('your_api_key'));
}

/**
 * Which provider will actually be used.
 *
 * Priority: explicit AI_PROVIDER override -> GEMINI_API_KEY -> ANTHROPIC_API_KEY.
 * The override exists so you can keep both keys in .env.local (e.g. Gemini for
 * cheap bulk analysis, Claude for a quality comparison) without editing code.
 */
export function resolveAiProvider(): AiProvider | null {
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();

  if (forced === 'gemini' || forced === 'anthropic' || forced === 'claude') {
    const provider: AiProvider = forced === 'gemini' ? 'gemini' : 'anthropic';
    const keyName = provider === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
    if (!hasConfiguredValue(keyName)) {
      throw new AppError(`AI_PROVIDER is set to "${provider}" but ${keyName} is missing.`, {
        status: 500,
        resolution: `Add ${keyName} to .env.local, or clear AI_PROVIDER to fall back to auto-detection.`,
      });
    }
    return provider;
  }

  if (hasConfiguredValue('GEMINI_API_KEY')) return 'gemini';
  if (hasConfiguredValue('ANTHROPIC_API_KEY')) return 'anthropic';

  return null;
}

function requireProvider(task: string): AiProvider {
  const provider = resolveAiProvider();

  if (!provider) {
    throw new AppError(`No AI provider is configured for ${task}.`, {
      status: 500,
      resolution:
        'Set GEMINI_API_KEY (recommended, plus GEMINI_MODEL) or ANTHROPIC_API_KEY in .env.local before running AI analysis.',
    });
  }

  return provider;
}

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number
): Promise<ViralSegment[]> {
  const provider = requireProvider('viral segment detection');

  console.log(`[AI] Viral segment detection via ${provider}.`);
  return provider === 'gemini'
    ? detectWithGemini(transcript, videoDuration)
    : detectWithClaude(transcript, videoDuration);
}

export async function generateHookText(clipTranscriptText: string): Promise<string> {
  const provider = requireProvider('hook text generation');
  return provider === 'gemini'
    ? generateHookWithGemini(clipTranscriptText)
    : generateHookWithClaude(clipTranscriptText);
}

export async function generateCtaText(clipTranscriptText: string): Promise<string> {
  const provider = requireProvider('CTA text generation');
  return provider === 'gemini'
    ? generateCtaWithGemini(clipTranscriptText)
    : generateCtaWithClaude(clipTranscriptText);
}
