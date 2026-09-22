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

function hasConfiguredValue(name: string) {
  const value = process.env[name]?.trim();
  return Boolean(value && !value.includes('your_api_key'));
}

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number
): Promise<ViralSegment[]> {
  if (hasConfiguredValue('GEMINI_API_KEY')) {
    return detectWithGemini(transcript, videoDuration);
  }

  if (hasConfiguredValue('ANTHROPIC_API_KEY')) {
    return detectWithClaude(transcript, videoDuration);
  }

  throw new AppError('No AI provider is configured for viral detection.', {
    status: 500,
    resolution:
      'Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local before running viral clip detection.',
  });
}

export async function generateHookText(clipTranscriptText: string): Promise<string> {
  if (hasConfiguredValue('GEMINI_API_KEY')) {
    return generateHookWithGemini(clipTranscriptText);
  }

  if (hasConfiguredValue('ANTHROPIC_API_KEY')) {
    return generateHookWithClaude(clipTranscriptText);
  }

  throw new AppError('No AI provider is configured for hook generation.', {
    status: 500,
    resolution:
      'Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local before generating hook text.',
  });
}

export async function generateCtaText(clipTranscriptText: string): Promise<string> {
  if (hasConfiguredValue('GEMINI_API_KEY')) {
    return generateCtaWithGemini(clipTranscriptText);
  }

  if (hasConfiguredValue('ANTHROPIC_API_KEY')) {
    return generateCtaWithClaude(clipTranscriptText);
  }

  throw new AppError('No AI provider is configured for CTA generation.', {
    status: 500,
    resolution:
      'Set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env.local before generating CTA text.',
  });
}
