/**
 * Dev-only seed: one transcribed portrait video with a finished pipeline and
 * four clips in different states, plus matching job rows with timestamps so the
 * dashboard can exercise per-step timings, the cancel buttons and the clip grid.
 *
 *   npx tsx scripts/seed-demo.ts        (seed)
 *   npx tsx scripts/seed-demo.ts --wipe (remove the seeded rows)
 */
import { getDatabase } from '../lib/db';

const VIDEO_ID = 'demo-video-001';
const CLIP_IDS = ['demo-clip-a', 'demo-clip-b', 'demo-clip-c', 'demo-clip-d'];

const iso = (offsetSeconds: number) =>
  new Date(Date.UTC(2026, 9, 9, 12, 0, 0) + offsetSeconds * 1000).toISOString();

const aiAnalysis = (rank: number, title: string) => ({
  rank,
  timestamp: { start: '00:04:00', end: '00:05:12' },
  duration: { minutes: 1, seconds: 12, total_seconds: 72 },
  why_this_will_go_viral: 'Strong hook in the first three seconds and a clear payoff.',
  hook_line_analysis: {
    hook_line: 'Nobody tells you this about short video.',
    hook_timestamp: { start: '00:04:02', end: '00:04:06' },
    why_it_works: 'Curiosity gap plus a bold claim.',
    place_before_clip: true,
  },
  retention_analysis: {
    curiosity_first_3_seconds: 'High',
    payoff_location: 'End of clip',
    open_loop: true,
    likely_to_watch_till_end: true,
    predicted_retention: 'strong',
  },
  psychological_trigger: { dominant_trigger: 'curiosity', explanation: 'Open loop.' },
  safety_analysis: {
    risk_level: 'low',
    monetization_risk: 'None',
    reused_content_risk: 'None',
    algorithm_suppression_risk: 'None',
    ineligible_for_fyf_risk: 'None',
    risky_words: [],
  },
  viral_packaging: {
    hook_text_on_video: 'Nobody tells you this',
    video_title: title,
    cta_text: 'Follow for part two',
    hashtags: ['#creator', '#shorts'],
    platform_safe: true,
    eligibility_or_reach_concerns: 'None',
    words_to_change: [],
  },
  scores: { viral_score: 9, retention_score: 8, controversy_score: 2, shareability_score: 8 },
});

const record = (clipId: string, extra: Record<string, unknown>) => ({
  _id: clipId,
  videoId: VIDEO_ID,
  videoTitle: 'Demo recording.mp4',
  start: 240,
  end: 312,
  hookDuration: 3,
  hookText: 'Nobody tells you this',
  ctaText: 'Follow for part two',
  ctaDuration: 3,
  filterPreset: 'filter-none',
  layout: 'speaker-focus',
  captionEngine: 'remotion',
  createdAt: iso(0),
  updatedAt: iso(60),
  ...extra,
});

const job = (
  id: string,
  type: string,
  payload: Record<string, unknown>,
  extra: { status: string; startedAt?: string; finishedAt?: string; clipId?: string; error?: string }
) => ({
  id,
  type,
  payload_json: JSON.stringify(payload),
  status: extra.status,
  attempts: 1,
  max_attempts: 2,
  error: extra.error ?? null,
  progress: extra.status === 'done' ? 100 : 40,
  result_json: null,
  created_at: iso(0),
  available_at: iso(0),
  started_at: extra.startedAt ?? null,
  finished_at: extra.finishedAt ?? null,
  retry_delay_ms: 2000,
  video_id: VIDEO_ID,
  clip_id: extra.clipId ?? null,
});

const clipJobData = (clipId: string) => ({
  clipId,
  videoId: VIDEO_ID,
  start: 240,
  end: 312,
  hookDuration: 3,
  hookText: 'Nobody tells you this',
  ctaText: 'Follow for part two',
  ctaDuration: 3,
  filterPreset: 'filter-none',
  captionPresetId: '',
  layout: 'speaker-focus',
  captionEngine: 'remotion',
});

const clipJob = (
  clipId: string,
  extra: { status: string; startedAt?: string; finishedAt?: string; error?: string }
) => job(`clip:${clipId}`, 'clip-processing', clipJobData(clipId), { ...extra, clipId });

const db = getDatabase();

if (process.argv.includes('--wipe')) {
  db.prepare('DELETE FROM videos WHERE id = ?').run(VIDEO_ID); // cascades to clips + jobs
  console.log('Demo rows removed.');
  process.exit(0);
}

const transcript = {
  text: 'Nobody tells you this about short video. The first three seconds decide everything.',
  segments: [
    { id: 1, start: 240, end: 250, text: 'Nobody tells you this about short video.' },
    { id: 2, start: 250, end: 262, text: 'The first three seconds decide everything.' },
  ],
  words: [],
};

const pipeline = {
  autoDetect: true,
  autoRender: true,
  viral: {
    clipCount: 4,
    minClipDuration: 30,
    maxClipDuration: 90,
    includeHookText: true,
    includeCta: true,
  },
};

db.prepare(
  `INSERT OR REPLACE INTO videos (
     id, original_name, file_name, file_base, file_path, duration, width, height, file_size,
     status, transcript_json, transcription_provider, transcription_model, error,
     created_at, updated_at, pipeline_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
).run(
  VIDEO_ID,
  'Demo recording.mp4',
  '001_demo_recording.mp4',
  'demo_recording',
  '/home/user/clipcraft-local/uploads/001_demo_recording.mp4',
  900,
  1080,
  1920,
  1024 * 1024 * 40,
  'transcribed',
  JSON.stringify(transcript),
  'deepgram',
  'nova-3',
  iso(0),
  iso(200),
  JSON.stringify(pipeline)
);

const insertClip = db.prepare(
  `INSERT OR REPLACE INTO clips (
     id, video_id, start, end, output_path, status, progress, record_json, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

insertClip.run(CLIP_IDS[0], VIDEO_ID, 240, 312, '/generated-clips/001_demo_recording/rank-1-demo.mp4', 'done', 100,
  JSON.stringify(record(CLIP_IDS[0], {
    aiAnalysis: aiAnalysis(1, 'The 3-second rule nobody tells you'),
    outputPath: '/generated-clips/001_demo_recording/rank-1-demo.mp4',
    outputFileSize: 8_000_000,
    outputFps: 30,
    status: 'done',
    progress: 100,
  })), iso(210), iso(430));

insertClip.run(CLIP_IDS[1], VIDEO_ID, 300, 372, null, 'processing', 42,
  JSON.stringify(record(CLIP_IDS[1], {
    aiAnalysis: aiAnalysis(2, 'Why retention dies at second four'),
    status: 'processing',
    progress: 42,
  })), iso(210), iso(470));

insertClip.run(CLIP_IDS[2], VIDEO_ID, 400, 465, null, 'pending', 0,
  JSON.stringify(record(CLIP_IDS[2], {
    aiAnalysis: aiAnalysis(3, 'Hook lines that stop the scroll'),
    status: 'pending',
    progress: 0,
  })), iso(210), iso(210));

insertClip.run(CLIP_IDS[3], VIDEO_ID, 500, 560, null, 'failed', 0,
  JSON.stringify(record(CLIP_IDS[3], {
    aiAnalysis: aiAnalysis(4, 'The CTA mistake killing your reach'),
    status: 'failed',
    progress: 0,
    error: 'FFmpeg exited with code 1 (demo seed).',
  })), iso(210), iso(450));

const insertJob = db.prepare(
  `INSERT OR REPLACE INTO jobs (
     id, type, payload_json, status, attempts, max_attempts, error, progress, result_json,
     created_at, available_at, started_at, finished_at, retry_delay_ms, video_id, clip_id
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const jobRows = [
  job(`transcription:${VIDEO_ID}`, 'transcription', { videoId: VIDEO_ID }, {
    status: 'done', startedAt: iso(5), finishedAt: iso(155),
  }),
  job(`viral-detection:${VIDEO_ID}`, 'viral-detection', { videoId: VIDEO_ID }, {
    status: 'done', startedAt: iso(156), finishedAt: iso(200),
  }),
  clipJob(CLIP_IDS[0], {
    status: 'done', startedAt: iso(210), finishedAt: iso(430),
  }),
  clipJob(CLIP_IDS[1], {
    status: 'running', startedAt: iso(440),
  }),
  clipJob(CLIP_IDS[2], {
    status: 'queued',
  }),
  clipJob(CLIP_IDS[3], {
    status: 'failed', startedAt: iso(215), finishedAt: iso(450),
    error: 'FFmpeg exited with code 1 (demo seed).',
  }),
];

for (const row of jobRows) {
  insertJob.run(
    row.id, row.type, row.payload_json, row.status, row.attempts, row.max_attempts,
    row.error, row.progress, row.result_json, row.created_at, row.available_at,
    row.started_at, row.finished_at, row.retry_delay_ms, row.video_id, row.clip_id
  );
}

console.log('Seeded', VIDEO_ID, 'with', CLIP_IDS.length, 'clips and', jobRows.length, 'job rows.');
