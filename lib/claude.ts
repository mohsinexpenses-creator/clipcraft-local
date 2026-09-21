import Anthropic from '@anthropic-ai/sdk';
import { TranscriptData, ViralSegment } from './types';
import { getPromptTemplate } from './db';

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_api_key')) {
    return null;
  }
  return new Anthropic({ apiKey });
}

export async function detectViralSegments(
  transcript: TranscriptData,
  videoDuration: number
): Promise<ViralSegment[]> {
  const templateDoc = await getPromptTemplate('viral_detection');
  const client = getAnthropicClient();

  if (client && templateDoc) {
    try {
      console.log('[Claude] Calling Claude API for viral segment detection...');

      // Format transcript text with timestamps
      const formattedTranscript = transcript.segments
        .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}`)
        .join('\n');

      const userPrompt = templateDoc.template.replace('{{transcript}}', formattedTranscript);

      const response = await client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1500,
        temperature: 0.5,
        system: templateDoc.systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const contentText = response.content[0].type === 'text' ? response.content[0].text : '';
      console.log('[Claude] Raw response:', contentText);

      // Extract JSON array from response
      const jsonMatch = contentText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const parsed: ViralSegment[] = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item) => ({
            start: Math.max(0, Number(item.start) || 0),
            end: Math.min(videoDuration, Number(item.end) || videoDuration),
            score: Math.min(10, Math.max(1, Number(item.score) || 7.5)),
            reason: String(item.reason || 'High engagement segment'),
            hookText: String(item.hookText || 'WATCH THIS FIRST').toUpperCase(),
          }));
        }
      }
    } catch (err) {
      console.warn('[Claude] Viral segment detection API call failed, using fallback:', err);
    }
  } else {
    console.log('[Claude] ANTHROPIC_API_KEY not set or template missing. Generating fallback viral segments...');
  }

  return generateFallbackViralSegments(transcript, videoDuration);
}

export async function generateHookText(
  clipTranscriptText: string
): Promise<string> {
  const templateDoc = await getPromptTemplate('hook_generation');
  const client = getAnthropicClient();

  if (client && templateDoc) {
    try {
      console.log('[Claude] Calling Claude API for hook text generation...');

      const userPrompt = templateDoc.template.replace('{{clipTranscript}}', clipTranscriptText);

      const response = await client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 100,
        temperature: 0.7,
        system: templateDoc.systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const contentText = response.content[0].type === 'text' ? response.content[0].text.trim() : '';
      // Clean up quotes or markdown formatting
      const cleaned = contentText.replace(/^["']|["']$/g, '').trim().toUpperCase();
      if (cleaned.length > 0 && cleaned.length < 80) {
        return cleaned;
      }
    } catch (err) {
      console.warn('[Claude] Hook text API call failed, using fallback:', err);
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
    
    // Pick 3 spread-out windows
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
    // Default segments based on video length
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
