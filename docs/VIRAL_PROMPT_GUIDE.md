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
  overlap rules is [`lib/ai.ts`](../lib/ai.ts); the strict parser for the response is
  [`lib/viral-response.ts`](../lib/viral-response.ts); the response type is `ViralClip` in
  [`lib/types.ts`](../lib/types.ts).

Templates are **seeded once** (insert-if-missing) so your edits survive restarts. After an app
update that ships a new built-in prompt, press **Reset to defaults** on the Prompt Templates
page (or `POST /api/prompt-templates` with `{"action":"reset"}`) to load it — this overwrites
the built-in templates only, never your own custom templates.

Because templates are seeded only once, an existing database can still hold an **older prompt that
returns the old flat array**. That shape is **not accepted any more**: detection stops with the error
*The AI response must be a JSON object with a "clips" array* - press **Reset to defaults** to load
the current prompt.

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

### How the response is used

The response is validated once and then stored **as it is** on the clip (`ClipRecord.aiAnalysis`,
inside the existing `clips.record_json` column - no schema change). Nothing is copied into a second
set of fields; the dashboard and the worker read the same object:

| AI field | Used for |
| --- | --- |
| `timestamp.start` / `.end` | The render window (`ClipRecord.start` / `end`, in seconds) |
| `viral_packaging.hook_text_on_video` | The editable hook text (`ClipRecord.hookText`, upper-cased) - the on-screen hook overlay |
| `viral_packaging.cta_text` | The editable CTA text (`ClipRecord.ctaText`) - the end-screen CTA overlay |
| `viral_packaging.video_title` | Clip card headline and the name of the downloaded `.mp4` |
| `hook_line_analysis.hook_timestamp` | The moment the worker duplicates as the hook intro (converted to seconds there; unreadable or missing -> the clip's first seconds) |
| `hook_line_analysis.place_before_clip` | **Stored only** - the renderer always prepends the hook intro when hook text is on |
| `rank` | Dashboard order and the `#n` badge |
| `scores`, `retention_analysis`, `psychological_trigger`, `safety_analysis`, the rest of `viral_packaging` | Clip card badges and the collapsible **AI analysis** panel |

`hookText` / `ctaText` still obey the *Hook text* / *CTA text* switches (§2, §5) and still fall back
to the dedicated `hook_generation` / `cta_generation` templates when the AI leaves them empty.
Clips created before this schema have no `aiAnalysis`: they keep rendering, with no AI panel, no
score or rank, a title taken from the hook text, and the hook intro taken from the first seconds.

### How the response is read (`lib/viral-response.ts`)

The detection call asks the provider for raw JSON, so the text is parsed as it is - no code-fence
stripping, no repair, no coercion. The response must be **exactly** `{ "clips": [ ... ] }` with at
least one clip, and **every clip must match the schema above**: all fields present, strings /
numbers / booleans / arrays of the right type, scores from 0 to 10, and the enum fields spelled
exactly as the project defines them (`predicted_retention`: Weak, Medium, Strong, Extreme;
`dominant_trigger`: Curiosity, Anger, Inspiration, Shock, Validation, Fear, Controversy, Humor;
`risk_level`: Low, Medium, High; risky-word `action`: censor, replace, mute, remove).

Anything else is rejected with an error that names the field and the value received, e.g.
`clips[2].retention_analysis.predicted_retention must be one of: Weak, Medium, Strong, Extreme (got "Weak | Medium | Strong | Extreme")`.
One invalid clip rejects the whole response (retry); a bare array, a single clip object, the old
flat format and cut-off output are all rejected the same way. Nothing is guessed or skipped.

Timestamps are strings. The clip window accepts seconds (`"125.5s"`, `"125.5"` - the transcript's own
style) or a clock (`"02:05"`, `"00:02:05"`, `"00:02:05.5"`) and nothing else; it must be readable and
start before it ends. An end a little past the video is clamped to the video's length; a clip with
less than a second left inside the video is an error.

### Rules that are enforced in code (not just in the prompt)

- Clip length must stay within `[minClipDuration, maxClipDuration]`: over-long clips are trimmed to
  the maximum and short ones are extended to the minimum (a clip that cannot reach the minimum
  before the video ends is dropped).
- **No overlapping clips**: clips are taken in the AI's `rank` order (viral score breaks ties) and
  any overlapping lower-ranked clip is dropped.
- At most `clipCount` clips are created. If the model returns fewer, up to two follow-up passes ask
  for the missing ones in the same JSON format (an invalid follow-up answer is ignored with a
  warning); their clips are appended after the ones already kept.
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
| AI analysis | the model's `hook_text_on_video` stays in `aiAnalysis.viral_packaging` | kept as well (only the overlay is off) |

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
- **Adding or renaming a schema field:** edit the schema block in the prompt, then `ViralClip` in
  `lib/types.ts`, the `FIELDS` list in `lib/viral-response.ts` and the fixture in
  `tests/viral-fixtures.ts` - a test fails until all four agree. The route and the database need no
  change; the card and the AI panel read the new field from `aiAnalysis`.
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
