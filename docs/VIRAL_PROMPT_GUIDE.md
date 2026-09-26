# Viral Prompt System — How It Works & How To Use It

ClipCraft now ships with the full **expert social-media-strategist viral clip prompt** built in.
It ranks transcript moments by viral potential and returns complete clip packaging (hook line,
on-screen hook text, CTA, title, hashtags, safety analysis, engagement scores) in one AI pass.

This guide explains where the prompt lives, what the pre-generation options do, and how to
customize everything.

---

## 1. Where the prompt lives

- **UI:** `/prompt-templates` → *Viral Short Segments Detection* template.
- **Storage:** MongoDB, collection `promptTemplates` (document `_id: "prompt-viral-detection"`).
- **Code:** the shipped default is `DEFAULT_PROMPT_TEMPLATES` in [`lib/presets.ts`](../lib/presets.ts);
  the runtime that fills variables, calls the LLM chain, and parses the JSON is
  [`lib/ai.ts`](../lib/ai.ts).

Templates are **seeded once** (`$setOnInsert`) so your edits survive restarts. After an app
update that ships a new built-in prompt, press **Reset to defaults** on the Prompt Templates
page (or `POST /api/prompt-templates` with `{"action":"reset"}`) to load it — this overwrites
the built-in templates only, never your own custom templates.

---

## 2. Options asked before generating clips

On the dashboard, **AI clip options** (shown for the selected video, above *Generated clips*):

| Option | Default | What it does |
| --- | --- | --- |
| **Number of clips** | `10` | How many top viral moments to generate (1–25). Injected as `{{clipCount}}` and enforced after parsing. |
| **Min clip length** | `60s` | Clips shorter than this are **never** created (prompt rule + code enforcement). |
| **Max clip length** | `90s` | Clips longer than this are trimmed to the max (the prompt's 60–90s rule). |
| **Hook text** (switch) | **On** | When **off**, no hook text is generated, the clip gets `hookDuration: 0`, and renders with **no hook intro/overlay**. |

Choices persist in `localStorage` (`clipcraft.viral-options`) and are sent with the request:

```http
POST /api/videos/{videoId}/detect-viral
Content-Type: application/json

{
  "options": {
    "clipCount": 10,
    "minClipDuration": 60,
    "maxClipDuration": 90,
    "includeHookText": true
  }
}
```

All fields are optional — omitting the body uses the defaults above. Values are clamped
server-side (`clipCount` 1–25, durations 5–1200s) and never trusted raw.

---

## 3. Template variables

Filled automatically at run time (every occurrence):

| Placeholder | Filled with |
| --- | --- |
| `{{transcript}}` | The timestamped transcript (`[start - end]: text` per segment) — **required** |
| `{{clipCount}}` | Number of clips to generate |
| `{{minClipDuration}}` | Minimum clip length in seconds |
| `{{maxClipDuration}}` | Maximum clip length in seconds |

The hook/CTA templates use `{{clipTranscript}}` (the clip's own transcript text) and only run
as **fallbacks** when the viral prompt leaves `hookText` / `ctaText` empty.

---

## 4. What the prompt returns (JSON contract)

The prompt demands a **strict JSON array, sorted by viral potential (highest first)**, with
timestamps taken **only** from the transcript. Per clip:

| Prompt analysis section | JSON field(s) | Where it is used |
| --- | --- | --- |
| Clip window ("Timestamp") | `start`, `end` | Render window of the clip |
| Title | `title` | Clip card headline |
| "Why This Will Go Viral" | `reason` | Clip card *Why it works* + `viralReason` |
| Hook Text On Video | `hookText` | On-screen hook overlay (rendered) |
| Hook Line Analysis | `hookLine`, `hookLineStart`, `hookLineEnd` | Stored on the clip (cold-open reference) |
| CTA Text (End Screen) | `ctaText` | End-screen CTA overlay (rendered) |
| Hashtags | `hashtags` | Clip card |
| Retention Analysis | `retentionStrength` (`Weak/Medium/Strong/Extreme`) | Clip card badge |
| Psychological Trigger | `psychologicalTrigger` | Clip card badge |
| Safety & Eligibility | `safetyRisk` (`Low/Medium/High`), `safetyNotes` (exact risky words + `->` replacement) | Clip card warning box |
| Viral Scoring System | `score`, `scores.{viral,retention,controversy,shareability}` | Clip score flame + score breakdown |

Example clip object:

```json
{
  "start": 120.5,
  "end": 182.0,
  "title": "He quit his job with $400 in the bank 😳",
  "score": 9.4,
  "reason": "Immediate emotional tension ... viewers argue in the comments ...",
  "hookText": "HE QUIT WITH $400 LEFT",
  "hookLine": "I literally had four hundred dollars in my account",
  "hookLineStart": 122.1,
  "hookLineEnd": 125.8,
  "ctaText": "Would you have done it? 👇",
  "hashtags": ["#mindset", "#startup", "#risk"],
  "retentionStrength": "Strong",
  "psychologicalTrigger": "Curiosity",
  "safetyRisk": "Low",
  "safetyNotes": "No risky wording detected.",
  "scores": { "viral": 9, "retention": 9, "controversy": 7, "shareability": 8 }
}
```

### Rules that are enforced in code (not just in the prompt)

- Clip length must stay within `[minClipDuration, maxClipDuration]` (over-long clips trimmed,
  under-minimum clips dropped).
- Timestamps are clamped to the real video duration — a hallucinated timestamp can never
  produce a clip outside the source.
- **No overlapping clips**: segments are ranked by `score` and overlapping lower-ranked ones
  are dropped.
- At most `clipCount` clips are created, ordered by viral potential.

---

## 5. Hook text on/off — what actually changes

| | Hook text **ON** (default) | Hook text **OFF** |
| --- | --- | --- |
| AI generation | `hookText` from the prompt (fallback: hook template) | skipped entirely |
| Clip record | `hookDuration: 3`, hook text stored | `hookDuration: 0`, `hookText: ""` |
| Render | 3s duplicated hook intro + on-screen hook overlay | no hook intro, no hook overlay |
| Clip card | editable hook text field | "Hook overlay off — type text to enable it" (typing text re-enables a 3s hook on render) |

---

## 6. Customizing the prompt

1. Open **`/prompt-templates`** → *Viral Short Segments Detection*.
2. Edit the **system prompt** (the AI's role/expertise) or the **prompt template** (rules +
   JSON schema). Keep `{{transcript}}` and the JSON schema block — everything above the
   schema block is fair game (rules, selection criteria, analysis sections).
3. **Save template** — changes apply to the next detection run.
4. Made a mess? **Reset to defaults** restores the shipped prompt.

Tuning tips:

- **More/fewer clips:** change *Number of clips* in AI clip options — no prompt edit needed.
- **Different clip length:** change min/max in AI clip options; the placeholders update the
  prompt automatically.
- **Richer or leaner output:** the per-clip analysis strings have length caps after parsing
  (reason 300 chars, safety notes 400, title 160, hook/CTA 120/120) — raise them in
  `sanitizeSegment` (`lib/ai.ts`) if you want longer fields.
- **Output token budget** scales with clip count (`1200 + 320 × clipCount`, capped at 6144) —
  if you add many more fields to the JSON schema, raise the cap in `detectViralSegments`.
- If a provider returns valid-but-short JSON (fewer clips than requested), that's the LLM
  fallback chain doing its best with a small model — retrying usually fills more slots.

---

## 7. One-pass economics

With the built-in viral prompt, hook text and CTA text come **from the detection pass itself**.
The dedicated `hook_generation` / `cta_generation` templates only run when the model omits
those fields — so a 10-clip run typically costs **1 LLM call** instead of 21.
