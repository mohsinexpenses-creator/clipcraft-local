import path from 'path';
import { AppError, toErrorMessage } from '../../lib/errors';
import { log } from '../../lib/logger';
import {
  cleanupSampledFrames,
  detectFacesWithMouth,
  detectWithSkinHeuristic,
  loadFaceApi,
  loadLandmarkNet,
  sampleSegmentFrames,
} from '../face-detector';
import { computeVoiceEnvelope, extractPcmMono } from './audio';
import { Tracker, Track, FrameDetection } from './tracker';
import { SpeakerSegment, buildSpeakerTimeline } from './speaker';

/**
 * Active Speaker Detection (ASD) pipeline for one clip window.
 *
 *   sample frames (mirrored) ─┐
 *   extract audio envelope  ──┼─>  per-frame faces (box + mouth-open)
 *                              │        │
 *                              │        v
 *                              │   multi-face TRACKER (stable Person A/B/C ids)
 *                              │        │
 *                              │        v
 *                              └──>  AUDIO + VISUAL FUSION -> speaker timeline
 *
 * Everything is local and free: face-api (tinyFaceDetector + faceLandmark68Net)
 * on the tfjs CPU backend, the 68-landmark weights are committed under
 * models/face-landmarks/, and the "who is talking" gate is plain audio energy
 * DSP - no paid APIs, no cloud, no face recognition.
 *
 * Cost model: frames are sampled at <= 4 fps (bounded by frame budget), so a
 * 90 s clip runs at most ~240 neural inferences instead of 2,700.
 */

export interface AsdResult {
  /** Every tracked person (points in MIRRORED source pixels, t clip-relative). */
  tracks: Track[];
  /** Per-time active speaker (merged runs). */
  speakerSegments: SpeakerSegment[];
  /** Distinct people who were ever the active speaker. */
  speakerCount: number;
  method: 'face-api+landmarks+audio' | 'face-api+audio' | 'skin+audio';
  hasLandmarks: boolean;
  hasAudio: boolean;
  /** Busiest frame (how many faces at once). */
  maxFacesSeen: number;
  framesUsed: number;
  framesTotal: number;
  sampleFps: number;
  /** Share of sampled frames that were voiced (0..1). */
  voicedRatio: number;
}

export interface AsdOptions {
  /** False when the source has no audio stream. */
  hasAudio: boolean;
  /** Upper bound on the frame-sampling fps (default 4). */
  maxSampleFps?: number;
  /** Upper bound on sampled frames (default 240). */
  maxFrames?: number;
}

const DEFAULT_MAX_SAMPLE_FPS = 4;
const DEFAULT_MAX_FRAMES = 240;

export async function detectSpeakerTimeline(
  videoPath: string,
  start: number,
  duration: number,
  videoWidth: number,
  videoHeight: number,
  options: AsdOptions
): Promise<AsdResult> {
  if (!Number.isFinite(videoWidth) || !Number.isFinite(videoHeight) || videoWidth <= 0 || videoHeight <= 0) {
    throw new AppError('Cannot run speaker detection without a valid source resolution.', {
      status: 400,
      details: `width=${videoWidth}, height=${videoHeight}`,
      resolution: 'Re-upload the video so FFmpeg can read its resolution.',
    });
  }

  const maxFps = options.maxSampleFps ?? DEFAULT_MAX_SAMPLE_FPS;
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;

  let frames: string[] = [];
  let sampleFps = 0;
  try {
    log.detail(
      `ASD · sampling up to ${maxFrames} frames @ <=${maxFps}fps + audio envelope ` +
      `(window ${start.toFixed(1)}s +${duration.toFixed(1)}s)`
    );

    // 1) Frames and audio can be extracted independently - run them together.
    const sampled = await sampleSegmentFrames(videoPath, start, duration, maxFps, maxFrames);
    frames = sampled.frames;
    sampleFps = sampled.fps;

    const pcm = options.hasAudio ? await extractPcmMono(videoPath, start, duration) : new Int16Array(0);
    const voice =
      pcm.length > 0 ? computeVoiceEnvelope(pcm, 16000, sampleFps).voice : new Array(frames.length).fill(0);

    // 2) Neural runtime (optional) + landmark net (optional).
    const runtime = await loadFaceApi();
    const hasLandmarks = runtime ? await loadLandmarkNet(runtime) : false;

    // 3) Per-frame detection -> tracker.
    const tracker = new Tracker();
    let maxFacesSeen = 0;
    let framesUsed = 0;
    let usedSkinFallback = false;

    for (let i = 0; i < frames.length; i += 1) {
      const framePath = frames[i];
      const t = i / sampleFps;

      let faces = runtime
        ? await detectFacesWithMouth(runtime, framePath, hasLandmarks)
        : [];
      if (faces.length === 0) {
        faces = await detectWithSkinHeuristic(framePath);
        if (faces.length > 0) usedSkinFallback = true;
      }

      maxFacesSeen = Math.max(maxFacesSeen, faces.length);
      if (faces.length === 0) {
        // Still feed an empty frame so the tracker ages its grace periods.
        tracker.update(t, []);
        continue;
      }

      // Scale from the sampled 640px-wide frame to source pixels.
      const dets: FrameDetection[] = faces.map((f) => {
        const scaleFactor = videoWidth / Math.max(1, f.frameWidth);
        return {
          cx: f.centerX * scaleFactor,
          cy: f.centerY * scaleFactor,
          w: f.faceWidth * scaleFactor,
          mouthOpen: f.mouthOpen ?? null,
        };
      });

      tracker.update(t, dets);
      framesUsed += 1;
    }

    // 4) Fuse audio + per-track visual cues into a speaker timeline.
    const tracks = tracker.allVisible();
    const { segments, speakerCount } = buildSpeakerTimeline({
      duration,
      fps: sampleFps,
      voice,
      tracks,
      frameWidth: videoWidth,
    });

    const voicedRatio =
      voice.length > 0 ? voice.filter((v) => v >= 0.18).length / voice.length : 0;

    log.ok(
      `ASD: ${tracks.length} person(s) tracked${maxFacesSeen > 1 ? `, ${maxFacesSeen} on screen at once` : ''}, ` +
      `${speakerCount} active speaker(s), ${Math.round(voicedRatio * 100)}% voiced, ` +
      `frames=${framesUsed}/${frames.length}, fps=${sampleFps.toFixed(2)}, ` +
      `cue=${hasLandmarks ? 'landmark mouth-open' : 'prominence-only'}`
    );

    if (tracks.length > 0) {
      for (const track of tracks) {
        const third = videoWidth / 3;
        const avgX = Math.round(
          track.points.reduce((sum, p) => sum + p.cx, 0) / track.points.length
        );
        const side = avgX < third ? 'LEFT' : avgX > third * 2 ? 'RIGHT' : 'centre';
        log.detail(
          `  person#${track.id}: visible ${track.visibleTime.toFixed(1)}s, ` +
          `avg face ${Math.round(track.avgW)}px, ${track.points.length} sightings, ` +
          `sits ${side} (avg x=${avgX} of ${videoWidth})`
        );
      }
    }

    const method: AsdResult['method'] = !runtime
      ? 'skin+audio'
      : usedSkinFallback
        ? 'skin+audio'
        : hasLandmarks
          ? 'face-api+landmarks+audio'
          : 'face-api+audio';

    return {
      tracks,
      speakerSegments: segments,
      speakerCount,
      method,
      hasLandmarks,
      hasAudio: pcm.length > 0,
      maxFacesSeen,
      framesUsed,
      framesTotal: frames.length,
      sampleFps,
      voicedRatio,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Speaker detection failed.', {
      details: toErrorMessage(error),
      resolution: 'Inspect the sampled-frame and audio-extract FFmpeg commands in the worker log, and retry.',
    });
  } finally {
    // sampleSegmentFrames keeps the dir alive for the caller; clean it here.
    if (frames.length > 0) {
      cleanupSampledFrames(path.dirname(frames[0]));
    }
  }
}
