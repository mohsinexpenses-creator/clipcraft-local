# Clip layouts & active-speaker tracking

Every clip is rendered in 9:16 from the landscape source. **How** the source is framed
is a per-clip choice with two options — plus automatic tracking of **who is talking**.

## The two layouts

| Layout | What it looks like | Best for |
| --- | --- | --- |
| **Speaker focus** | A single full-height 9:16 window slides along the source and **follows the active speaker**. When the speaker changes, the frame glides to the new person (~0.6s camera-like pan). | Podcasts, interviews, one dominant talker. |
| **Split screen (multi-person split)** | An adaptive grid of stacked crops (up to 4 people — a 2-person clip gets two stacked 1080×960 panes: the person sitting **left** is always the **top** pane, the **right** person the **bottom** one, so the layout never swaps mid-clip). Each pane tracks its person; the **active speaker's pane gets a red emphasis frame** that follows the speaker timeline. | Two-person conversations, panels. |

Pick the layout per clip in **Generate → clip card → "Layout (9:16 output)"**, or send
`layout: 'speaker-focus' | 'split-screen'` to `POST /api/clips`. Renders are queued —
in-flight jobs keep the layout they were created with.

## How the active speaker is tracked

The worker pipeline (`worker/asd/` + `worker/layout.ts`):

1. **Samples** the clip window at ≤8 fps (mirrored + downscaled to 640px, capped at
   480 frames) and extracts an audio **voice envelope** per sample from the segment
   PCM (`worker/asd/audio.ts`). The 8 fps rate matters: the audio↔motion cues need
   several samples per decision window to be meaningful, and it is what lets the
   label flip promptly on a turn change.
2. **Detects faces** with OpenCV **YuNet** (`face_detection_yunet_2023mar.onnx`, run via
   `onnxruntime-node` — download with `npm run setup:yunet`) — this replaced the old
   face-api / tiny_face_detector pipeline.
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
   cell is a per-person crop path, dead-zone filtered + decimated (≤24 keyframes) so
   the FFmpeg command stays inside Windows' command-line limit.

### Failure behaviour (no fallbacks by design)

There is deliberately **no fallback detector** (no skin-tone heuristic, no
"pretend tracking"): a clip whose speaker cannot be determined is a clip that
would be badly framed, so the render stops with a clear error instead of
guessing.

| Situation | Behaviour |
| --- | --- |
| YuNet model missing / ONNX runtime broken | The render job fails with "YuNet face detection is unavailable - run `npm run setup:yunet`" (the `/startup-validation` page shows the same warning before you start). |
| One face visible | Always active (no scoring). |
| A frame YuNet misses | The tracker's keep-alive grace period carries the last known position; nothing is guessed. |

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
