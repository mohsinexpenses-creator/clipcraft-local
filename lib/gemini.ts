import { GoogleGenerativeAI } from '@google/generative-ai';
import { getPromptTemplate } from './db';
import { AppError, ensureEnvVar, toErrorMessage } from './errors';
import { getGeminiModelName } from './models';
import { TranscriptData, ViralSegment } from './types';

function getGeminiModel() {
  const apiKey = ensureEnvVar('GEMINI_API_KEY', 'call Gemini for viral segment detection and hook generation');
  const modelName = getGeminiModelName();
  console.log(`[Gemini] Initializing Gemini model '${modelName}'...`);

  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: modelName });
}

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number
): Promise<ViralSegment[]> {
  if (!transcript.segments.length) {
    throw new AppError('Cannot run viral detection without transcript segments.', {
      status: 400,
      resolution: 'Re-run transcription first and make sure the transcript contains timestamped segments.',
    });
  }

  const templateDoc = await getPromptTemplate('viral_detection');
  if (!templateDoc) {
    throw new AppError('The viral_detection prompt template was not found in MongoDB.', {
      status: 500,
      resolution: 'Restart the app so default prompt templates seed into MongoDB, or recreate the template in the Prompt Templates page.',
    });
  }

  if (!templateDoc.template.includes('{{transcript}}')) {
    throw new AppError('The viral_detection prompt template is missing the {{transcript}} placeholder.', {
      status: 500,
      resolution: 'Edit the prompt template and add {{transcript}} where the transcript should be injected.',
    });
  }

  try {
    const model = getGeminiModel();
    console.log('[Gemini] Calling Gemini API for viral segment detection...');

    const formattedTranscript = transcript.segments
      .map((segment) => `[${segment.start.toFixed(1)}s - ${segment.end.toFixed(1)}s]: ${segment.text}`)
      .join('\n');

    const userPrompt = templateDoc.template.replace('{{transcript}}', formattedTranscript);
    const fullPrompt = `${templateDoc.systemPrompt}\n\n${userPrompt}`;

    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const contentText = response.text().trim();

    console.log('[Gemini] Raw response:', contentText);

    const jsonMatch = contentText.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!jsonMatch) {
      throw new AppError('Gemini did not return a JSON array for viral segments.', {
        status: 502,
        details: contentText,
        resolution: 'Tighten the viral detection prompt so the model returns only strict JSON.',
      });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new AppError('Gemini returned an empty viral segment list.', {
        status: 502,
        resolution: 'Adjust the transcript or prompt template and retry viral detection.',
      });
    }

    return parsed.map((item, index) => sanitizeSegment(item, index, videoDuration));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Gemini viral segment detection failed.', {
      status: 502,
      details: toErrorMessage(error),
      resolution:
        'Verify GEMINI_API_KEY, the configured model name, and the prompt template, then retry.',
    });
  }
}

export async function generateHookText(clipTranscriptText: string): Promise<string> {
  return generateShortOverlayText({
    transcriptText: clipTranscriptText,
    templateType: 'hook_generation',
    logLabel: 'hook text generation',
    invalidResponseSummary: 'Gemini returned an invalid hook text response.',
    failureSummary: 'Gemini hook text generation failed.',
  });
}

export async function generateCtaText(clipTranscriptText: string): Promise<string> {
  return generateShortOverlayText({
    transcriptText: clipTranscriptText,
    templateType: 'cta_generation',
    logLabel: 'CTA generation',
    invalidResponseSummary: 'Gemini returned an invalid CTA response.',
    failureSummary: 'Gemini CTA generation failed.',
  });
}

async function generateShortOverlayText(options: {
  transcriptText: string;
  templateType: 'hook_generation' | 'cta_generation';
  logLabel: string;
  invalidResponseSummary: string;
  failureSummary: string;
}): Promise<string> {
  const normalizedTranscript = options.transcriptText.trim();
  if (!normalizedTranscript) {
    throw new AppError('Cannot generate overlay text from an empty clip transcript.', {
      status: 400,
      resolution: 'Choose a clip segment that contains spoken transcript text.',
    });
  }

  const templateDoc = await getPromptTemplate(options.templateType);
  if (!templateDoc) {
    throw new AppError(`The ${options.templateType} prompt template was not found in MongoDB.`, {
      status: 500,
      resolution:
        'Restart the app so default prompt templates seed into MongoDB, or recreate the missing template in the Prompt Templates page.',
    });
  }

  if (!templateDoc.template.includes('{{clipTranscript}}')) {
    throw new AppError(`The ${options.templateType} prompt template is missing the {{clipTranscript}} placeholder.`, {
      status: 500,
      resolution:
        'Edit the prompt template and add {{clipTranscript}} where the clip transcript should be injected.',
    });
  }

  try {
    const model = getGeminiModel();
    console.log(`[Gemini] Calling Gemini API for ${options.logLabel}...`);

    const userPrompt = templateDoc.template.replace('{{clipTranscript}}', normalizedTranscript);
    const fullPrompt = `${templateDoc.systemPrompt}\n\n${userPrompt}`;

    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const contentText = response.text().trim();
    const cleaned = contentText.replace(/^["']|["']$/g, '').trim().toUpperCase();

    if (!cleaned || cleaned.length >= 80) {
      throw new AppError(options.invalidResponseSummary, {
        status: 502,
        details: contentText,
        resolution: 'Tighten the prompt so the model returns a short plain-text overlay.',
      });
    }

    return cleaned;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(options.failureSummary, {
      status: 502,
      details: toErrorMessage(error),
      resolution:
        'Verify GEMINI_API_KEY, the configured model name, and the prompt template, then retry.',
    });
  }
}

function sanitizeSegment(item: unknown, index: number, videoDuration: number): ViralSegment {
  const segment = (item || {}) as Record<string, unknown>;
  const start = Number(segment.start);
  const end = Number(segment.end);
  const score = Number(segment.score);
  const reason = String(segment.reason || '').trim();
  const hookText = String(segment.hookText || '').trim().toUpperCase();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new AppError(`Gemini returned invalid timestamps for viral segment #${index + 1}.`, {
      status: 502,
      details: JSON.stringify(item),
      resolution: 'Update the viral detection prompt so every segment includes numeric start and end values.',
    });
  }

  if (!reason) {
    throw new AppError(`Gemini returned a viral segment without a reason (#${index + 1}).`, {
      status: 502,
      details: JSON.stringify(item),
      resolution: 'Update the viral detection prompt so every segment includes a reason field.',
    });
  }

  return {
    start: Math.max(0, start),
    end: Math.min(videoDuration, end),
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 8,
    reason,
    hookText,
  };
}
