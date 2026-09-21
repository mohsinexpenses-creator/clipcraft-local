import { GoogleGenerativeAI } from '@google/generative-ai';
import { TranscriptData, ViralSegment } from './types';
import { getPromptTemplate } from './db';

function getGeminiModel() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_api_key')) {
    return null;
  }

  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  console.log(`[Gemini] Initializing Gemini model '${modelName}'...`);
  const genAI = new GoogleGenerativeAI(apiKey);
  return genAI.getGenerativeModel({ model: modelName });
}

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number
): Promise<ViralSegment[]> {
  const templateDoc = await getPromptTemplate('viral_detection');
  const model = getGeminiModel();

  if (model && templateDoc) {
    try {
      console.log('[Gemini] Calling Gemini API for viral segment detection...');

      const formattedTranscript = transcript.segments
        .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}`)
        .join('\n');

      const userPrompt = templateDoc.template.replace('{{transcript}}', formattedTranscript);
      const fullPrompt = `${templateDoc.systemPrompt}\n\n${userPrompt}`;

      const result = await model.generateContent(fullPrompt);
      const response = await result.response;
      const contentText = response.text();

      console.log('[Gemini] Raw response:', contentText);

      // Extract JSON array from Gemini response
      const jsonMatch = contentText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const parsed: ViralSegment[] = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item) => ({
            start: Math.max(0, Number(item.start) || 0),
            end: Math.min(videoDuration, Number(item.end) || videoDuration),
            score: Math.min(10, Math.max(1, Number(item.score) || 8.5)),
            reason: String(item.reason || 'High engagement segment'),
            hookText: String(item.hookText || 'WATCH THIS FIRST').toUpperCase(),
          }));
        }
      }
    } catch (err) {
      console.warn('[Gemini] Viral segment detection API call failed, using fallback:', err);
    }
  } else {
    console.log('[Gemini] GEMINI_API_KEY not set or template missing. Generating fallback viral segments...');
  }

  return generateFallbackViralSegments(transcript, videoDuration);
}

export async function generateHookText(
  clipTranscriptText: string
): Promise<string> {
  const templateDoc = await getPromptTemplate('hook_generation');
  const model = getGeminiModel();

  if (model && templateDoc) {
    try {
      console.log('[Gemini] Calling Gemini API for hook text generation...');

      const userPrompt = templateDoc.template.replace('{{clipTranscript}}', clipTranscriptText);
      const fullPrompt = `${templateDoc.systemPrompt}\n\n${userPrompt}`;

      const result = await model.generateContent(fullPrompt);
      const response = await result.response;
      const contentText = response.text().trim();

      const cleaned = contentText.replace(/^["']|["']$/g, '').trim().toUpperCase();
      if (cleaned.length > 0 && cleaned.length < 80) {
        return cleaned;
      }
    } catch (err) {
      console.warn('[Gemini] Hook text API call failed, using fallback:', err);
    }
  }

  return generateFallbackHookText(clipTranscriptText);
}

function generateFallbackViralSegments(
  transcript: TranscriptData,
  duration: number
): ViralSegment[] {
  const segments: ViralSegment[] = [];

  if (transcript.segments.length >= 3) {
    const totalSegs = transcript.segments.length;

    const idx1 = Math.floor(totalSegs * 0.1);
    const idx2 = Math.floor(totalSegs * 0.4);
    const idx3 = Math.floor(totalSegs * 0.7);

    const s1 = transcript.segments[idx1];
    const s2 = transcript.segments[idx2];
    const s3 = transcript.segments[idx3];

    segments.push({
      start: Math.max(0, s1.start),
      end: Math.min(duration, s1.start + 25),
      score: 9.4,
      reason: 'Strong initial statement with key value proposition.',
      hookText: 'THIS CHANGES EVERYTHING YOU KNOW',
    });

    segments.push({
      start: Math.max(0, s2.start),
      end: Math.min(duration, s2.start + 28),
      score: 8.8,
      reason: 'Surprising insight and core technical breakdown.',
      hookText: 'THE SECRET NO ONE TALKS ABOUT',
    });

    if (s3) {
      segments.push({
        start: Math.max(0, s3.start),
        end: Math.min(duration, s3.start + 30),
        score: 8.2,
        reason: 'Actionable takeaway and conclusion summary.',
        hookText: 'STOP DOING IT THE OLD WAY',
      });
    }
  } else {
    const segDur = Math.min(25, Math.max(10, duration / 2));
    segments.push({
      start: 0,
      end: Math.min(duration, segDur),
      score: 9.0,
      reason: 'Opening highlight and introductory hook.',
      hookText: 'MUST WATCH HIGHLIGHT',
    });

    if (duration > segDur + 10) {
      segments.push({
        start: Math.min(duration - 15, segDur + 5),
        end: Math.min(duration, segDur + 5 + segDur),
        score: 8.5,
        reason: 'Key breakdown and conclusion.',
        hookText: 'DO NOT MISS THIS PART',
      });
    }
  }

  return segments;
}

function generateFallbackHookText(transcriptText: string): string {
  const words = transcriptText.split(/\s+/).filter(Boolean);
  if (words.length <= 6) {
    return words.join(' ').toUpperCase();
  }

  const hooks = [
    'STOP SCROLLING FOR A SECOND',
    'THE 1 THING YOU NEED TO KNOW',
    'THIS IS REVOLUTIONARY',
    'YOU WON T BELIEVE THIS',
    'WATCH UNTIL THE VERY END',
  ];

  const randomIndex = Math.floor(Math.random() * hooks.length);
  return hooks[randomIndex];
}
