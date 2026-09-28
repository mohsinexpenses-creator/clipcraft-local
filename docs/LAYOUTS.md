# Clip layouts & active-speaker tracking

Every clip is rendered in 9:16 from the landscape source. **How** the source is framed
is a per-clip choice with two options — plus automatic tracking of **who is talking**.

## The two layouts

| Layout | What it looks like | Best for |
| --- | --- | --- |
| **Speaker focus** | A single full-height 9:16 window slides along the source and **follows the active speaker**. When the speaker changes, the frame glides to the new person in ~0.45s. | Podcasts, interviews, one dominant talker. |
| **Split screen** | The source is mirrored, then two stacked crops (each scaled to 1080×960) are vstacked into the 1080×1920 canvas. **The active speaker is always the TOP pane** — when the speaker changes, the panes swap (with the same 0.45s glide). | Two-person conversations, back-and-forth. |

Pick the layout per clip in **Generate → clip card → "Clip layout"**, or send
`layout: 'speaker-focus' | 'split-screen'` to `POST /api/clips`. Renders are queued —
in-flight jobs keep the layout they were created with.

## How the active speaker is tracked

The worker (see `worker/speaker-tracker.ts` + `worker/yunet-detector.ts`):

1. **Samples** the clip window at ~4 fps (mirrored + downscaled) and extracts an audio
   envelope per sample from the segment waveform.
2. **Detects faces** with OpenCV **YuNet** (`face_detection_yunet_2023mar.onnx`, run via
   `onnxruntime-node` — download with `npm run setup:yunet`).
3. **Tracks** detections across samples with identity-free motion continuity
   (`matchBestTrack`, threshold on box+thumb distance). No face recognition, no
   embeddings, no identity of who the person is — only "the face on the left".
4. **Scores** who is talking every sample with multiple cues:
   - **audio↔motion correlation** — the talking face moves when the audio envelope
     rises (mouth, jaw, or any face-region motion);
   - **motion energy** vs. the other faces;
   - **continuity** (whoever was speaking keeps the frame) and **face size**.

   Because mouth motion is only one cue, a **covered mouth** (handheld mic, mask,
   hand) still works: correlation flattens and the worst-case cues (continuity, size,
   full-face motion) decide. With no usable audio at all the method degrades to pure
   visual (`yunet-visual`).
5. **Hysteresis** (0.75s minimum between switches + a score margin) stops the frame
   from flickering on borderline calls; a single visible face is always the speaker.
6. Turns decisions into **crop timelines** — keyframes the FFmpeg filter interpolates
   every frame, so the 9:16 window *glides* between speakers instead of jumping.

### Fallbacks

| Situation | Behaviour |
| --- | --- |
| YuNet model missing / no ONNX runtime | Static center crop (`center-fallback`); worker log + startup check explain how to enable tracking. |
| Very short clip / no faces found | Deterministic dominant-face or center crop. |
| One face | Always active (no scoring). |

## FFmpeg plumbing (for the curious)

- **Speaker focus** — `-vf "hflip,crop=W:H:x='EXPR':y=…,scale=…"` where `EXPR` is a
  piecewise `if(lt(t,T),v+slope*(t-t0),…)` over the focus keyframes (clamped to the
  source). Embedded in single quotes — the filtergraph parser needs no comma escaping.
- **Split screen** — `-filter_complex "[0:v]hflip,split=2[sa][sb]; [sa]crop=…,scale=1080:960[spTop]; [sb]crop=…,scale=1080:960[spBottom]; [spTop][spBottom]vstack=inputs=2,…[vout]"`.
- All crop coordinates live in **mirrored space** (the chain flips first) and `t` is
  0-based within the segment.

Layout choice is stored on the clip record (`clip.layout`) alongside
`hookStylePresetId` / `ctaStylePresetId` (see [OVERLAYS.md](./OVERLAYS.md)).
