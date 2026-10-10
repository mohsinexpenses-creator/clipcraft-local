# Clip layouts & active-speaker tracking

Every clip is rendered in 9:16 from the landscape source. **How** the source is framed
is a per-clip choice with two options — plus automatic tracking of **who is talking**.

## The two layouts

| Layout | What it looks like | Best for |
| --- | --- | --- |
| **Speaker focus** | A single full-height 9:16 window slides along the source and **follows the active speaker**. When the speaker changes, the frame glides to the new person (~0.6s camera-like pan). | Podcasts, interviews, one dominant talker. |
| **Split screen (multi-person split)** | An adaptive grid of stacked crops (up to 4 people — a 2-person clip gets two stacked 1080×960 panes: the person sitting **left** is always the **top** pane, the **right** person the **bottom** one, so the layout never swaps mid-clip). Each pane is a **locked camera**: it is placed on its person at the start and then holds perfectly still — it only glides to re-centre them if their head actually leaves the frame. Nothing is drawn over the panes (no speaker highlight frame), and the captions / hook / CTA are placed so they never cover a face ([details](./OVERLAYS.md#overlays-follow-the-layout)). | Two-person conversations, panels. |

Pick the layout per clip in **Generate → clip card → "Layout (9:16 output)"**, or send
`layout: 'speaker-focus' | 'split-screen'` to `POST /api/clips`. Renders are queued —
in-flight jobs keep the layout they were created with.

## How the active speaker is tracked

The worker pipeline (`worker/asd/` + `worker/layout.ts`):

1. **Samples** the clip window at ≤8 fps (mirrored + downscaled to **960px**, capped at
   480 frames) and extracts an audio **voice envelope** per sample from the segment
   PCM (`worker/asd/audio.ts`). The 8 fps rate matters: the audio↔motion cues need
   several samples per decision window to be meaningful, and it is what lets the
   label flip promptly on a turn change.
2. **Detects faces** with OpenCV **YuNet** (`face_detection_yunet_2023mar.onnx`, run via
   `onnxruntime-node` — download with `npm run setup:yunet`) — this replaced the old
   face-api / tiny_face_detector pipeline. The model input is a fixed 640×640 square,
   so `worker/yunet-detector.ts` feeds it the way OpenCV does — **letterboxed, never
   stretched** — and scans a wide frame with **overlapping square tiles plus one
   full-frame pass** (merged with NMS; a face cut in half by a tile seam is discarded
   because the neighbouring tile sees it whole). A tile is enlarged to fill the model
   input, which is what lets it find the small faces of a podcast **wide shot**: a
   ~100 px host in a 1080p frame scores ~0.9 (a full-frame pass sees it at ~0.7, and
   faces under ~60 px not at all). The only size filter is a speck floor of 1.4 % of
   the frame width — *who counts as a person* is decided later, by the layout planner.
3. **Tracks** detections across samples with an identity-free constant-velocity
   nearest-neighbour tracker (`worker/asd/tracker.ts`): stable "Person A/B/C" ids with a
   keep-alive grace period so a person survives a mic swing, a hand, or a brief overlap
   without losing their framing. **No face recognition** — we never learn who anyone is.
4. **Scores** who is talking per 0.6 s window, decided every 0.25 s
   (`worker/asd/speaker.ts`), with multiple cues:
   - **voice-gated motion** (the strongest cue) — how much a face moves *while the
     shared audio is loud*. The speaker's face articulates in lockstep with their own
     speech so this is high; a non-speaker's random gestures land at uncorrelated
     times and this stays near zero. It is a sum of products (not Pearson
     correlation), so it is stable on the few samples a window holds.
   - **audio↔motion correlation** (Pearson) — secondary confirmation: the talking
     face moves when the voice envelope rises (full-face AND mouth-region thumbnails,
     so a covered mouth still leaves whole-face motion);
   - **motion energy** vs. the other faces;
   - **mouth-opening variance** — only when a landmark cue exists (YuNet has none, so it
     simply contributes 0 there — the fusion never *needs* it);
   - **prominence** (face size) and **continuity** (the incumbent keeps the frame).

   Because mouth motion is only one cue, a **covered mouth** (handheld mic, mask, hand)
   still works: correlation/mouth terms flatten toward 0 and the worst-case cues
   (continuity, size, voice-gated motion) decide. With no usable audio at all the
   method degrades to the visual-only mix.
5. **Hysteresis + a reactive override** stop two people's scores from trading the
   label back and forth on borderline windows: a challenger must beat the incumbent by
   ~10 % (or the reactive rule below) AND the incumbent has held the frame for at least
   0.4 s. The **reactive override** flips the label on the next held window as soon as
   the incumbent's voice-gated motion drops low (they clearly stopped talking) and the
   challenger's rises high (they clearly started) — this is what kills the "frame
   lingers on the non-speaker after a turn change" behaviour. A single visible face is
   always the speaker.
6. Turns decisions into a **layout plan** (`worker/layout.ts`). Speaker focus: ONE
   stable anchor per speaker segment — the window stays LOCKED on the speaker's median
   position while they talk, then a fast 0.15 s *glide* to the next speaker's anchor
   (explicit keyframes, no drift). Split screen: the grid is sized by how many people
   **share the screen at the busiest moment** (never more panes than that, so
   fragmented track ids can't inflate 2 people into 3–4), but **two co-existing people
   always get two panes even if only one was judged the speaker** — the split is a
   statement about who is on screen, not about the (heuristic) speaker timeline. Each
   pane is a **locked camera** (next section), whose handful of glides is encoded as a
   short FFmpeg expression so the command stays far inside Windows' command-line limit.

   **Pane framing (target).** Every 2-, 3-, or 4-person cell uses its own aspect-matched
   source crop. By default, the face-box centre is placed at **38% of that pane's height**.
   `SPLIT_FACE_TARGET_FRAC` configures this vertical centre target (default `0.38`, clamped
   to `0.25–0.55`). `SPLIT_ZOOM` caps enlargement (default `1.5×`, clamped to `1–2×`;
   `1.0` means no enlargement). The 38%-of-pane face-size preference is used only when it
   fits within that cap; smaller source faces stay smaller rather than being heavily
   upscaled. Crops stay inside source dimensions and use the same math for wide top cells
   and narrow 3/4-grid cells. Very low-resolution sources may still need some enlargement
   to fill the 1080×1920 output; scaling cannot restore detail absent from the source. The
   configured centre target also informs the locked camera and overlay-safe face/head zones.

   **Who gets a pane.** Every active speaker, plus any other face that stays on screen
   ≥ 3 s *and* is at least 45 % as wide as the biggest speaker's (a much smaller
   "face" is a poster / screen / passer-by). A track must be ≥ 2 % of the frame width
   to count as a person at all.

### Locked panes — no shake (`worker/camera-lock.ts`)

A podcast wide shot has a perfectly static background, so *any* movement of a pane's crop
window shows as a shimmer of the whole background. The old planner chased the face (a
6–24 px dead zone, then a keyframe at every drift), and because FFmpeg's `crop` snaps the
window to whole even pixels, a slow creep turned into 2 px steps — "the frame is trying
to keep the face in the centre". Each pane now behaves like a camera on a tripod:

1. **Lock** — the window is placed on the person's *median* position over the first
   second they are seen, and then does not move at all.
2. **Hold** — while the head (face box + hair, `HEAD_*` constants) stays inside the
   window minus an 8 % safety margin, nothing happens. Nodding, swaying, gesturing and
   detector jitter are all absorbed by the margin.
3. **Re-centre** — only if the head has stayed outside that safe zone for ≥ 0.3 s (so
   one bad detection cannot trigger it) the window **glides** — smoothstep-eased,
   0.6–1.3 s depending on distance, starting ~0.15 s before the head reaches the edge —
   to restore the configured face target, and locks again. A person who is already as
   close to the frame edge as the window can get does not make it twitch; at most 10
   re-centres are planned per clip.

Detections are median-filtered (5 samples) first. The glides are written as a sum of
eased steps, `x0 + d1*S((t-t1)/g1) + …`, not an `if()` chain, so even ten of them are a
few hundred characters. The same maths runs in JavaScript to know where each face lands
on the canvas (used by the overlay placement) and is unit-tested against the FFmpeg
expression.

The camera-lock unit tests check stationary crops, eased non-overlapping glides, and
face visibility while moving. Rendered quality and timing still need validation with a
real source clip.

### Failure behaviour (no *silent* fallbacks)

There is deliberately **no fallback detector** (no skin-tone heuristic, no
"pretend tracking"): a clip whose speaker cannot be determined is a clip that
would be badly framed, so the render stops with a clear error instead of
guessing.

The one degradation that exists is **split screen → single window when fewer than two
people can be confirmed** (a split of one person is meaningless). It renders the
proper full-height 9:16 speaker window (the same ~1.8× framing as speaker focus —
never a zoomed-in one-cell "split"), and it is **never silent**: the worker log
prints `SPLIT SCREEN NOT APPLIED - <reason>` and the reason is stored on the clip
(`clip.layoutNote`) and shown on the clip card.

| Situation | Behaviour |
| --- | --- |
| YuNet model missing / ONNX runtime broken | The render job fails with "YuNet face detection is unavailable - run `npm run setup:yunet`" (the `/startup-validation` page shows the same warning before you start). |
| One face visible | Always active (no scoring). With **split screen** selected: single speaker window + the `layoutNote` above. |
| No face at all in the window | The render stops with "No faces were detected in this clip window (0 of N sampled frames…)". |
| Faces in < 25 % of the sampled frames | The log warns that framing will be unreliable (people very small, dark, turned away or covered). |
| A frame YuNet misses | The tracker's keep-alive grace period carries the last known position; nothing is guessed. |

## FFmpeg plumbing (for the curious)

The worker first prepares transparent PNG overlay sequences, then
`processVideoSegment()` makes the deliverable in **one FFmpeg video-encoding pass**.
The source is not encoded to an intermediate MP4 and decoded/re-encoded for captions:
the final graph applies the crop, colour treatment, hook intro, caption/card overlays,
and output scaling together. The output canvas is always 1080×1920.

- **Speaker focus** — `setpts=PTS-STARTPTS,hflip,crop=W:H:x='EXPR':y='EXPR2'` with
  source-clamped, piecewise smoothstep coordinates. `crop` uses `exact=1` so chroma
  subsampling does not force even-coordinate rounding; the final scale uses Lanczos.
- **Split screen** — each locked camera uses a static crop except for an eased glide
  when the head leaves its safe zone. Per-pane crops use `exact=1` and Lanczos scaling,
  then compose onto the 1080×1920 canvas. Cell assignment is stable across the clip.
- **Overlays** — the Remotion engine paints a full-timeline transparent PNG sequence;
  the native engine burns ASS captions onto the video and paints hook/CTA PNGs. FFmpeg
  composites those layers directly over the source-derived video frames before the final encode.
- **Encoding.** The final encode uses libx264 at CRF 17 and preset `slow` by default.
  `VIDEO_CRF` is configurable from 16 to 18; `VIDEO_PRESET` accepts a libx264 preset
  (default `slow`, or `medium` for faster output). This avoids a low-quality early
  encode followed by another generation loss. No quality metric or real-source A/V
  result is claimed here; verify with an actual source clip before judging quality.
- **Timing.** FFprobe's `avg_frame_rate` / `r_frame_rate` comparison flags VFR sources;
  those branches are normalized to the average rate before the hook/base concat. Video
  PTS is reset on each branch, audio PTS is rebased against the reported audio/video
  start-time difference and resampled to start at zero, and input seeks explicitly use
  accurate decode/discard seeking. `CAPTION_OFFSET_MS` shifts caption words only. Run
  `npm run verify:clip -- <file>` for per-stream starts, durations, rates and bitrates;
  see [SETUP.md](../SETUP.md) for probe availability and the debug output switch.
- Crop coordinates are evaluated in **mirrored space** (the chain flips before crop).

Layout choice is stored on the clip record (`clip.layout`; `clip.layoutNote` when it
could not be applied) alongside `captionEngine` and
`hookStylePresetId` / `ctaStylePresetId` (see [OVERLAYS.md](./OVERLAYS.md)).
