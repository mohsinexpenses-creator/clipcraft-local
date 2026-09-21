import fs from 'fs';
import { TranscriptData, WordTimestamp, TranscriptSegment } from './types';

export async function transcribeWithDeepgram(audioWavPath: string): Promise<TranscriptData | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_api_key')) {
    return null;
  }

  try {
    console.log('[Deepgram] Sending audio to Deepgram REST API (Nova-2 model)...');
    const audioBuffer = fs.readFileSync(audioWavPath);

    const url = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&paragraphs=true';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Deepgram] API returned HTTP ${response.status}: ${errText}`);
      return null;
    }

    const result = await response.json();
    const channel = result?.results?.channels?.[0]?.alternatives?.[0];
    if (!channel) {
      console.warn('[Deepgram] No transcription results returned.');
      return null;
    }

    const fullText = channel.transcript || '';
    const rawWords = channel.words || [];

    const words: WordTimestamp[] = rawWords.map((w: any) => ({
      word: w.punctuated_word || w.word,
      start: Number(w.start) || 0,
      end: Number(w.end) || Number(w.start) + 0.3,
      confidence: Number(w.confidence) || 0.9,
    }));

    const paragraphs = result?.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || [];
    const segments: TranscriptSegment[] = [];

    if (paragraphs.length > 0) {
      paragraphs.forEach((p: any, idx: number) => {
        const segText = p.sentences?.map((s: any) => s.text).join(' ') || '';
        segments.push({
          id: idx,
          start: Number(p.start) || 0,
          end: Number(p.end) || 0,
          text: segText,
        });
      });
    } else {
      const chunkSize = 15;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize);
        const segStart = chunk[0].start;
        const segEnd = chunk[chunk.length - 1].end;
        const text = chunk.map((w) => w.word).join(' ');

        segments.push({
          id: Math.floor(i / chunkSize),
          start: segStart,
          end: segEnd,
          text,
        });
      }
    }

    console.log(`[Deepgram] Successfully transcribed audio. Total words: ${words.length}`);

    return {
      text: fullText,
      segments,
      words,
    };
  } catch (err) {
    console.warn('[Deepgram] Deepgram API call failed:', err);
    return null;
  }
}
