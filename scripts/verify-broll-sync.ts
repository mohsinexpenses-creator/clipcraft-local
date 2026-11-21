/**
 * Offline proof that Phase 4's exact sync holds, on REAL transcript data.
 *
 * It replays the same pure code the worker runs - `parseBrollAnalysis` (which
 * anchors every moment to a transcript word and floors it onto the frame grid)
 * and `scheduleBroll` (which never moves a start) - against the clip's stored
 * transcript, and prints the `[BROLL-SYNC]` lines plus a verdict.
 *
 *   npm run verify:broll-sync -- <clipId>
 *   npm run verify:broll-sync -- --transcript data/words.json --fps 30
 *
 * The transcript form is `[{ "word": "cash", "start": 12.4, "end": 12.6 }]`,
 * clip-relative, as it appears on `clip.words` / `video.transcript.words`.
 *
 * Exit code 0 only when every placed card starts within one frame of its anchor
 * word and no two cards overlap.
 */

import fs from "node:fs/promises";
import { getClip, getVideo } from "../lib/db";
import { wordWithinClip } from "../lib/clip-time";
import type { WordTimestamp } from "../lib/types";
import { anchorMoment, floorToFrame } from "../lib/broll/sync";
import { scheduleBroll } from "../lib/broll/scheduler";

const STOPWORDS = new Set([
  "and", "the", "that", "this", "with", "from", "have", "were", "what", "when",
  "where", "which", "while", "your", "yours", "they", "them", "then", "than",
  "there", "these", "those", "about", "because", "been", "being", "just", "into",
]);

interface Sample {
  anchorText: string;
  start: number;
  end: number;
  relevance: number;
}

function usage(): void {
  console.error("Usage: npm run verify:broll-sync -- <clipId> [--fps 30]");
  console.error("       npm run verify:broll-sync -- --transcript <words.json> [--fps 30]");
}

async function readTranscriptFile(file: string): Promise<WordTimestamp[]> {
  const raw = await fs.readFile(file, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array of {word,start,end}`);
  return parsed
    .filter((entry): entry is WordTimestamp => {
      const word = entry as Partial<WordTimestamp>;
      return (
        typeof word.word === "string" &&
        typeof word.start === "number" &&
        typeof word.end === "number"
      );
    })
    .map((word) => ({ word: word.word, start: word.start, end: word.end }));
}

/**
 * Build sample moments from the transcript itself: every content word becomes an
 * anchor candidate. This is deliberately dense - dense anchors are the worst case
 * for "starts never move".
 */
function sampleMoments(words: readonly WordTimestamp[]): Sample[] {
  const out: Sample[] = [];
  for (const word of words) {
    const text = word.word.replace(/[^A-Za-z0-9'-]/g, "");
    if (text.length < 4) continue;
    // Function words are never anchors by themselves; the sample must reflect
    // what the analysis can actually ask for.
    if (STOPWORDS.has(text.toLowerCase())) continue;
    out.push({ anchorText: text, start: word.start, end: word.start + 1.3, relevance: 3 });
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((entry) => entry !== "--");
  const fpsIndex = args.indexOf("--fps");
  const fps = fpsIndex >= 0 ? Number(args[fpsIndex + 1]) || 30 : 30;
  const transcriptIndex = args.indexOf("--transcript");

  let words: WordTimestamp[] = [];
  let label = "";

  if (transcriptIndex >= 0) {
    const file = args[transcriptIndex + 1];
    if (!file) {
      usage();
      process.exitCode = 2;
      return;
    }
    words = await readTranscriptFile(file);
    label = file;
  } else {
    const clipId = args.find((entry) => !entry.startsWith("--") && entry !== String(fps));
    if (!clipId) {
      usage();
      process.exitCode = 2;
      return;
    }
    const clip = await getClip(clipId);
    if (!clip) {
      console.error(`Clip not found: ${clipId}`);
      process.exitCode = 1;
      return;
    }
    label = `clip ${clipId}`;
    // The clip's words are the video transcript words inside its window, made
    // clip-relative - exactly what the B-roll job anchors against.
    const video = await getVideo(clip.videoId);
    const start = clip.start;
    const end = clip.end;
    words = (video?.transcript?.words ?? [])
      .filter((word) => word.end >= start && word.start <= end)
      .flatMap((word) => {
        const relative = wordWithinClip(word, start, end);
        return relative ? [relative] : [];
      });
    if (words.length === 0) {
      console.error(
        `Clip ${clipId} has no stored words; pass --transcript <words.json> instead.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const clipDuration = words[words.length - 1].end;
  const samples = sampleMoments(words);

  // 1. Anchoring: every sample must land on its own word, one frame early at most.
  let anchored = 0;
  let worstFramesEarly = 0;
  const failures: string[] = [];
  for (const sample of samples) {
    const anchor = anchorMoment({ anchorText: sample.anchorText, words, start: sample.start, end: sample.end });
    if (!anchor) {
      failures.push(`un-anchored: "${sample.anchorText}"`);
      continue;
    }
    anchored += 1;
    const finalSeconds = floorToFrame(anchor.wordStart, fps) / fps;
    const framesEarly = Math.floor((anchor.wordStart - finalSeconds) * fps + 1e-6);
    worstFramesEarly = Math.max(worstFramesEarly, framesEarly);
    if (framesEarly < 0 || framesEarly > 1) {
      failures.push(
        `"${sample.anchorText}" starts ${framesEarly} frame(s) early (word ${anchor.wordStart.toFixed(3)}s -> ${finalSeconds.toFixed(3)}s)`,
      );
    }
  }

  // 2. Scheduling: dense anchors, starts never moved.
  const scheduled = scheduleBroll({
    clipDuration,
    hookDuration: 0,
    minCount: 0,
    maxCount: samples.length,
    fps,
    candidates: samples.map((sample, index) => {
      const anchor = anchorMoment({ anchorText: sample.anchorText, words, start: sample.start, end: sample.end });
      return {
        id: `sample-${index}`,
        kind: "landscape" as const,
        desiredStart: anchor ? floorToFrame(anchor.wordStart, fps) / fps : sample.start,
        desiredEnd: (anchor ? floorToFrame(anchor.wordStart, fps) / fps : sample.start) + 1.3,
        priority: 50,
        relevance: sample.relevance,
      };
    }),
  });

  for (const item of scheduled.items) {
    const anchor = samples[Number(item.id.split("-")[1])];
    const expected = Number((floorToFrame(anchor.start, fps) / fps).toFixed(3));
    if (Math.abs(item.start - expected) > 1e-6) {
      failures.push(`${item.id} start moved: ${item.start}s, anchor ${expected}s`);
    }
  }
  for (let index = 1; index < scheduled.items.length; index += 1) {
    const previous = scheduled.items[index - 1];
    const current = scheduled.items[index];
    if (current.start < previous.end - 1e-6) {
      failures.push(`overlap: ${previous.id} (${previous.end}) and ${current.id} (${current.start})`);
    }
  }

  console.log(`B-roll exact sync on ${label}`);
  console.log(
    `  words=${words.length} clip=${clipDuration.toFixed(1)}s fps=${fps} samples=${samples.length}`,
  );
  console.log(
    `  anchored=${anchored}/${samples.length} worst_early_frames=${worstFramesEarly} scheduled=${scheduled.items.length}/${samples.length}`,
  );
  if (scheduled.notes.length > 0) {
    console.log(`  scheduler notes (${scheduled.notes.length}):`);
    for (const note of scheduled.notes.slice(0, 8)) console.log(`    · ${note}`);
  }
  if (failures.length === 0) {
    console.log("  PASS: every start is its anchor word (at most one frame early), no overlap.");
    return;
  }
  console.log(`  FAIL (${failures.length}):`);
  for (const failure of failures.slice(0, 20)) console.log(`    ! ${failure}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
