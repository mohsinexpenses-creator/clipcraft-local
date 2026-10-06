# Viral Prompt System — How It Works & How To Use It

ClipCraft ships with the full **expert social-media-strategist viral clip prompt** built in.
It ranks transcript moments by viral potential and returns complete clip packaging and analysis
(hook line, retention, psychological trigger, safety, on-screen hook text, CTA, title, hashtags,
engagement scores) in one AI pass.

This guide explains where the prompt lives, what the pre-generation options do, and how to
customize everything.

---

## 1. Where the prompt lives

- **UI:** `/prompt-templates` → *Viral Short Segments Detection* template.
- **Storage:** SQLite, table `prompt_templates` (row `id: "prompt-viral-detection"`).
- **Code:** the shipped default is `DEFAULT_PROMPT_TEMPLATES` in [`lib/presets.ts`](../lib/presets.ts);
  the runtime that fills variables, calls the LLM chain and applies the clip-count / length /
  overlap rules is [`lib/ai.ts`](../lib/ai.ts); the **normalization layer** that reads the
  response (timestamps, JSON extraction, field mapping, validation) is
  [`lib/viral-response.ts`](../lib/viral-response.ts).

Templates are **seeded once** (insert-if-missing) so your edits survive restarts. After an app
update that ships a new built-in prompt, press **Reset to defaults** on the Prompt Templates
page (or `POST /api/prompt-templates` with `{"action":"reset"}`) to load it — this overwrites
the built-in templates only, never your own custom templates.

Because templates are seeded only once, an existing database can still hold an **older prompt that
returns the old flat array**. Both shapes are understood (see §4), so nothing breaks until you
choose to reset.

---

## 2. Options asked before generating clips

On the dashboard, **AI clip options** (shown for the selected video, above *Generated clips*):

| Option | Default | What it does |
| --- | --- | --- |
| **Number of clips** | `10` | How many top viral moments to generate (1–25). Injected as `{{clipCount}}` and enforced after parsing. |
| **Min clip length** | `60s` | Clips shorter than this are **never** created (prompt rule + code enforcement). This is the **only** length knob — the max is fixed internally. |
| **Max clip length** | `600s` (fixed) | Not exposed in the UI anymore. Clips longer than 600s are trimmed to 600s. Still injected as `{{maxClipDuration}}`. |
| **Hook text** (switch) | **On** | When **off**, no hook text is generated, the clip gets `hookDuration: 0`, and renders with **no hook intro/overlay**. |
| **CTA text** (switch) | **On** | When **off**, no CTA is generated, the clip gets `ctaDuration: 0`, and renders with **no CTA card**. |

Choices persist in `localStorage` (`clipcraft.viral-options`) and are sent with the request:

```http
POST /api/videos/{videoId}/detect-viral
Content-Type: application/json

{
  "options": {
    "clipCount": 10,
    "minClipDuration": 60,
    "includeHookText": true,
    "includeCta": true
  }
}
```

All fields are optional — omitting the body uses the defaults above. `maxClipDuration` is
**ignored** from the request (fixed at 600s internally). Other values are clamped
server-side (`clipCount` 1–25, min duration 5–600s) and never trusted raw.

---

## 3. Template variables

Filled automatically at run time (every occurrence):

| Placeholder | Filled with |
| --- | --- |
| `{{transcript}}` | The timestamped transcript (`[start - end]: text` per segment) — **required** |
| `{{clipCount}}` | Number of clips to generate |
| `{{minClipDuration}}` | Minimum clip length in seconds |
| `{{maxClipDuration}}` | Maximum clip length in seconds (fixed at 600s internally) |

The hook/CTA templates use `{{clipTranscript}}` (the clip's own transcript text) and only run
as **fallbacks** when the viral prompt leaves `hookText` / `ctaText` empty.

---

## 4. What the prompt returns (JSON contract)

The prompt demands **one strict JSON object** holding a `clips` array, **sorted by viral ranking
(rank 1 = most viral)**, with every timestamp taken **only** from the transcript. Per clip:

```json
{
  "clips": [
    {
      "rank": 1,
      "timestamp": { "start": "00:01:05", "end": "00:02:10" },
      "duration": { "minutes": 1, "seconds": 5, "total_seconds": 65 },
      "why_this_will_go_viral": "He admits the one thing every founder hides ...",
      "hook_line_analysis": {
        "hook_line": "I had four hundred dollars left in my account.",
        "hook_timestamp": { "start": "00:01:20", "end": "00:01:24" },
        "why_it_works": "A concrete number plus a confession opens a curiosity gap.",
        "place_before_clip": true
      },
      "retention_analysis": {
        "curiosity_first_3_seconds": "...",
        "payoff_location": "00:01:58",
        "open_loop": true,
        "likely_to_watch_till_end": true,
        "predicted_retention": "Strong"
      },
      "psychological_trigger": { "dominant_trigger": "Curiosity", "explanation": "..." },
      "safety_analysis": {
        "risk_level": "Medium",
        "monetization_risk": "...",
        "reused_content_risk": "...",
        "algorithm_suppression_risk": "...",
        "ineligible_for_fyf_risk": "...",
        "risky_words": [{ "word_or_phrase": "damn", "action": "replace", "safer_replacement": "darn" }]
      },
      "viral_packaging": {
        "hook_text_on_video": "HE HAD $400 LEFT",
        "video_title": "He quit his job with $400 in the bank 😳",
        "cta_text": "Would you have done it? 👇",
        "hashtags": ["#mindset", "#startup", "#risk"],
        "platform_safe": true,
        "eligibility_or_reach_concerns": "...",
        "words_to_change": ["damn"]
      },
      "scores": { "viral_score": 9, "retention_score": 9, "controversy_score": 7, "shareability_score": 8 }
    }
  ]
}
```

### Where each field goes

| AI field | App field (`ViralSegment` → `ClipRecord`) | Where it is used |
| --- | --- | --- |
| `timestamp.start` / `.end` | `start` / `end` | Render window of the clip |
| `rank` | `rank` | Dashboard order and the `#n` badge |
| `why_this_will_go_viral` | `reason` → `viralReason` | Clip card *Why it works* |
| `scores.viral_score` | `score` → `viralScore` | Clip card flame badge |
| `hook_line_analysis.hook_line` | `hookLine` | Stored (cold-open reference) |
| `hook_line_analysis.hook_timestamp.start` / `.end` | `hookLineStart` / `hookLineEnd` | The moment the renderer duplicates as the hook intro |
| `hook_line_analysis.place_before_clip` | `placeBeforeClip` | **Stored only** - the renderer always prepends the hook intro when hook text is on |
| `retention_analysis.predicted_retention` | `retentionStrength` | Clip card badge |
| `psychological_trigger.dominant_trigger` | `psychologicalTrigger` | Clip card badge |
| `safety_analysis.risk_level` | `safetyRisk` | Clip card badge |
| `safety_analysis.risky_words` | `safetyNotes` (one-line summary, `word -> replacement (action)`) | Clip card warning box |
| `viral_packaging.video_title` | `title` | Clip card headline |
| `viral_packaging.hook_text_on_video` | `hookText` (upper-cased) | On-screen hook overlay (rendered) |
| `viral_packaging.cta_text` | `ctaText` | End-screen CTA overlay (rendered) |
| `viral_packaging.hashtags` | `hashtags` | Clip card |
| the four `scores.*` | `scores` (when all four are valid) | Clip card score line |
| **every field above, complete** | `analysis` | Collapsible **AI analysis** panel on the clip card |

`hookText` / `ctaText` still obey the *Hook text* / *CTA text* switches (§2, §5) and still fall back
to the dedicated `hook_generation` / `cta_generation` templates when the AI leaves them empty.

### What is stored with each clip

`rank`, `placeBeforeClip` and `analysis` are ordinary optional fields of the clip record, so they
travel inside the existing `clips.record_json` column - **no schema change and no new SQL columns**.
`analysis` is the complete, validated analysis in the app's own shape (camelCase, timestamps as
seconds): `whyThisWillGoViral`, `duration`, `hookLineAnalysis`, `retentionAnalysis`,
`psychologicalTrigger`, `safetyAnalysis` (with `riskyWords[]`), `viralPackaging` and `scores`
(types: `ClipAnalysis` in [`lib/types.ts`](../lib/types.ts)). It keeps the AI's original packaging
text, so you can still see what the model suggested after you edit a clip's hook or CTA. Clips
created before this existed simply have no `analysis`; their card looks as it always did.

### How the response is read (`lib/viral-response.ts`)

This file is the one place that knows the response shape. If the prompt schema changes, change it
there (the test `the shipped prompt schema has exactly the fields ...` fails until the normalizer
and the fixtures follow the prompt).

- **Timestamps** may be seconds (`12.5`, `"12.5"`, `"12.5s"` - the transcript's own style),
  `"01:23"` (mm:ss), `"00:01:23"` (hh:mm:ss, optional fraction), unit forms (`"1m23s"`), or one
  `"start - end"` string. A clip is kept only if its window is readable, `start < end`, and it lies
  inside the video (an end past the video is clamped; a missing end is rebuilt from `duration`).
- **The hook moment** (`hook_timestamp`) is kept only when it overlaps the clip; otherwise the
  renderer falls back to the clip's first seconds, and the hook line text is still stored.
- **Enum fields** (`predicted_retention`, `dominant_trigger`, `risk_level`, `action`) become exactly
  one allowed value. Any casing works; a value that names *several* options - typically the model
  echoing the schema placeholder `"Weak | Medium | Strong | Extreme"` - is dropped, never stored
  as literal text.
- **Numbers / arrays / objects** are validated before use: scores accept `8`, `"8.5"`, `"8/10"` and
  are clamped to 0-10; booleans accept `true`/`false`/`"yes"`/`"no"`; hashtags get a missing `#`,
  duplicates removed; `risky_words` / `words_to_change` accept strings or objects; a block of the
  wrong type is treated as empty. A bad field is dropped or defaulted (missing viral score = 8) and
  never fails the run.
- **A bad clip never fails the run.** Only a clip whose time window cannot be trusted is skipped,
  with a server-log warning naming the clip and the reason. The run fails only when *no* clip is
  usable, and the error lists every reason.
- **Messy output is tolerated**: prose or a ```json fence around the JSON, trailing commas, and a
  response cut off by the output limit (the clips that finished are kept and the top-up pass asks
  for the rest). One syntactically broken clip does not discard its neighbours.
- **The old flat array** (`start`, `end`, `reason`, `hookText`, `hookLine`, `hashtags`,
  `retentionStrength`, `scores: { viral, ... }`, ...) is upgraded to the new shape first, so
  databases that still hold the older prompt keep working. It simply has no `rank` (clips are then
  ordered by score).

### Rules that are enforced in code (not just in the prompt)

- Clip length must stay within `[minClipDuration, maxClipDuration]`: over-long clips are trimmed to
  the maximum and short ones are extended to the minimum (a clip that cannot reach the minimum
  before the video ends is dropped).
- Timestamps are clamped to the real video duration - a hallucinated timestamp can never produce a
  clip outside the source.
- **No overlapping clips**: clips are taken in the AI's `rank` order (highest score first when
  there is no rank) and any overlapping lower-ranked clip is dropped.
- At most `clipCount` clips are created. If the model returns fewer, up to two follow-up passes ask
  for the missing ones in the same JSON format; their clips are appended after the ones already kept.
- `rank` is renumbered 1, 2, 3 ... over the clips that survive, so it never has gaps. The
  dashboard lists the newest detection run first and, inside a run, rank 1 first.

---

## 5. Hook text on/off — what actually changes

| | Hook text **ON** (default) | Hook text **OFF** |
| --- | --- | --- |
| AI generation | `hookText` from the prompt (fallback: hook template) | skipped entirely |
| Clip record | `hookDuration: 3`, hook text stored | `hookDuration: 0`, `hookText: ""` |
| Render | 3s duplicated hook intro + on-screen hook overlay | no hook intro, no hook overlay |
| Clip card | editable hook text field | "Hook overlay off — type text to enable it" (typing text re-enables a 3s hook on render) |
| AI analysis | the model's `hook_text_on_video` is kept in `analysis.viralPackaging` | kept as well (it is only the overlay that is off) |

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
- **Richer or leaner output:** the per-clip text fields have length caps after parsing (title 160,
  hook text 200, CTA 120, hook line 220, reason 600, other analysis text 800) — raise them in
  `LIMITS` at the top of `lib/viral-response.ts` if you want longer fields.
- **Adding or renaming a schema field:** edit the schema block in the prompt, read the new field in
  `lib/viral-response.ts` (and add it to `ClipAnalysis` in `lib/types.ts`), and update the fixture in
  `tests/viral-fixtures.ts`. The route, the database and the renderer need no change.
- **Output token budget** scales with clip count (`3,000 + 2,000 × clipCount`, capped at 40,000 —
  `detectionMaxTokens` in `lib/ai.ts`). Each clip's full analysis is roughly 1,500-2,000 tokens; if
  you add many more fields to the schema, raise the per-clip figure there.
- If a provider returns valid-but-short JSON (fewer clips than requested), that's the LLM
  fallback chain doing its best with a small model — retrying usually fills more slots.

---

## 7. One-pass economics

With the built-in viral prompt, hook text and CTA text come **from the detection pass itself**.
The dedicated `hook_generation` / `cta_generation` templates only run when the model omits
those fields — so a 10-clip run typically costs **1 LLM call** instead of 21.
