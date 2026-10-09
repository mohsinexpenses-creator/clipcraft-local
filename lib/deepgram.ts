import fs from 'fs';
import { TranscriptData, TranscriptSegment, WordTimestamp } from './types';
import { AppError, toErrorMessage } from './errors';
import { resolveDeepgram } from './app-settings';

export async function transcribeWithDeepgram(audioWavPath: string): Promise<TranscriptData> {
  // Key and model come from Settings -> AI providers, with `.env.local` underneath.
  const { apiKey, model } = await resolveDeepgram();
  if (!apiKey) {
    throw new AppError('DEEPGRAM_API_KEY is not configured.', {
      status: 500,
      resolution:
        'Add a key under Settings -> AI providers to transcribe with Deepgram, or switch the provider back to "auto" to use local whisper.cpp.',
    });
  }

  try {
    console.log(`[Deepgram] Sending audio to Deepgram REST API (${model} model)...`);
    const audioBuffer = fs.readFileSync(audioWavPath);

    const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true&punctuate=true&paragraphs=true`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'audio/wav',
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new AppError('Deepgram transcription request failed.', {
        status: 502,
        details: `HTTP ${response.status}: ${errText}`,
        resolution:
          'Verify DEEPGRAM_API_KEY, account quota, and network access to api.deepgram.com, then retry.',
      });
    }

    const result = await response.json();
    const channel = result?.results?.channels?.[0]?.alternatives?.[0];
    if (!channel) {
      throw new AppError('Deepgram did not return any transcription alternatives.', {
        status: 502,
        resolution:
          'Retry the upload or inspect the audio track to confirm the file contains readable speech.',
      });
    }

    const fullText = String(channel.transcript || '').trim();
    const rawWords = Array.isArray(channel.words) ? channel.words : [];

    const words: WordTimestamp[] = rawWords
      .map((rawWord: unknown) => {
        const word = rawWord as Record<string, unknown>;
        return {
          word: String(word.punctuated_word || word.word || '').trim(),
          start: Number(word.start) || 0,
          end: Number(word.end) || Number(word.start) + 0.3,
          confidence: Number(word.confidence) || 0,
        } satisfies WordTimestamp;
      })
      .filter((word: WordTimestamp) => Boolean(word.word));

    const paragraphs = result?.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs || [];
    const segments: TranscriptSegment[] = [];

    if (paragraphs.length > 0) {
      paragraphs.forEach((rawParagraph: unknown, idx: number) => {
        const paragraph = rawParagraph as Record<string, unknown>;
        const sentences = Array.isArray(paragraph.sentences)
          ? paragraph.sentences.map((rawSentence) => {
              const sentence = rawSentence as Record<string, unknown>;
              return String(sentence.text || '').trim();
            }).filter(Boolean)
          : [];
        const segText = sentences.join(' ');
        if (!segText.trim()) return;

        segments.push({
          id: idx,
          start: Number(paragraph.start) || 0,
          end: Number(paragraph.end) || 0,
          text: segText.trim(),
        });
      });
    } else {
      const chunkSize = 15;
      for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize);
        if (chunk.length === 0) continue;

        segments.push({
          id: Math.floor(i / chunkSize),
          start: chunk[0].start,
          end: chunk[chunk.length - 1].end,
          text: chunk.map((w) => w.word).join(' '),
        });
      }
    }

    if (!fullText || words.length === 0 || segments.length === 0) {
      throw new AppError('Deepgram returned an incomplete transcript.', {
        status: 502,
        details: `text=${fullText.length} chars, words=${words.length}, segments=${segments.length}`,
        resolution:
          'Retry the transcription or inspect whether the uploaded file has clear spoken audio.',
      });
    }

    console.log(`[Deepgram] Successfully transcribed audio. Total words: ${words.length}`);

    return {
      text: fullText,
      segments,
      words,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('Deepgram transcription failed unexpectedly.', {
      status: 502,
      details: toErrorMessage(error),
      resolution:
        'Verify DEEPGRAM_API_KEY, network access, and that the uploaded file contains valid audio, then retry.',
    });
  }
}
