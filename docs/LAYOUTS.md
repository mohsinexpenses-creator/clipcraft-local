# Clip layouts & active-speaker tracking

Every clip is rendered in 9:16 from the landscape source. **How** the source is framed
is a per-clip choice with two options — plus automatic tracking of **who is talking**.

## The two layouts

| Layout | What it looks like | Best for |
| --- | --- | --- |
| **Speaker focus** | A single full-height 9:16 window slides along the source and **follows the active speaker**. When the speaker changes, the frame glides to the new person (~0.6s camera-like pan). | Podcasts, interviews, one dominant talker. |
| **Split screen (multi-person split)** | An adaptive grid of stacked crops (2×2, up to 4 people — a 2-person clip gets two stacked 1080×960 panes). Each pane tracks its person; the **active speaker's pane gets a red emphasis frame** that follows the speaker timeline. | Two-person conversations, panels. |

Pick the layout per clip in **Generate → clip card → "Layout (9:16 output)"**, or send
`layout: 'speaker-focus' | 'split-screen'` to `POST /api/clips`. Renders are queued —
in-flight jobs keep the layout they were created with.

## How the active speaker is tracked

The worker pipeline (`worker/asd/` + `worker/layout.ts`):

1. **Samples** the clip window at ≤4 fps (mirrored + downscaled to 640px) and extracts
   an audio **voice envelope** per sample from the segment PCM (`worker/asd/audio.ts`).
2. **Detects faces** with OpenCV **YuNet** (`face_detection_yunet_2023mar.onnx`, run via
   `onnxruntime-node` — download with `npm run setup:yunet`) — this replaced the old
   face-api / tiny_face_detector pipeline.
3. **Tracks** detections across samples with an identity-free constant-velocity
   nearest-neighbour tracker (`worker/asd/tracker.ts`): stable "Person A/B/C" ids with a
   keep-alive grace period so a person survives a mic swing, a hand, or a brief overlap
   without losing their framing. **No face recognition** — we never learn who anyone is.
4. **Scores** who is talking per ~1s window (`worker/asd/speaker.ts`) with multiple cues:
   - **audio↔motion correlation** — the talking face moves when the audio envelope rises
     (mouth, jaw, cheek — measured on full-face AND mouth-region thumbnails, so a covered
     mouth still leaves whole-face motion);
   - **motion energy** vs. the other faces;
   - **mouth-opening variance** — only when a landmark cue exists (YuNet has none, so it
     simply contributes 0 there — the fusion never *needs* it);
   - **prominence** (face size) and **continuity** (the incumbent keeps the frame).

   Because mouth motion is only one cue, a **covered mouth** (handheld mic, mask, hand)
   still works: correlation/mouth terms flatten toward 0 and the worst-case cues
   (continuity, size, full-face motion) decide. With no usable audio at all the method
   degrades to pure visual.
5. **Hysteresis** (a challenger must beat the incumbent by 1.3× and an 0.8s minimum hold)
   stops the frame from flickering on borderline windows; a single visible face is always
   the speaker.
6. Turns decisions into a **layout plan** (`worker/layout.ts`): smoothed pan keyframes
   (EMA + slew limit so the camera never teleports) that the FFmpeg crop expression
   interpolates every frame — the 9:16 window *glides* between speakers instead of
   jumping. Keyframes are dead-zone filtered + decimated (≤24) so the FFmpeg command
   stays inside Windows' command-line limit (the old 200-branch expressions broke with
   `ENAMETOOLONG`).

### Fallbacks (a render never dies on bad detection)

| Situation | Behaviour |
| --- | --- |
| YuNet model missing / ONNX runtime broken | The legacy skin-tone heuristic track (`worker/frame-sampler.ts`), then a static center crop. Startup check + worker log explain `npm run setup:yunet`. |
| Very short clip / no faces found | Deterministic most-visible-person or center crop. |
| One face | Always active (no scoring). |
| ASD throws (bad audio, undecodable frames) | Legacy face track fallback in the render job. |

## FFmpeg plumbing (for the curious)

- **Speaker focus** — `hflip,crop=W:H:x='EXPR':y='EXPR2'` with piecewise-linear `EXPR`
  (nested `if(gte(t,…)…)` over the decimated pan keyframes, clamped to the source),
  then colour filter + scale to 1080×1920.
- **Split screen** — per-cell crops laid out on the 1080×1920 canvas (2/3/4-adaptive),
  with an emphasis layer for the active speaker's cell.
- All crop coordinates live in **mirrored space** (the chain flips first) and `t` is
  0-based within the segment.

Layout choice is stored on the clip record (`clip.layout`) alongside `captionEngine` and
`hookStylePresetId` / `ctaStylePresetId` (see [OVERLAYS.md](./OVERLAYS.md)).
