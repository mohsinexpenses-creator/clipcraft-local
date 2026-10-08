"use client"

import * as React from "react"
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Copy,
  Gauge,
  Megaphone,
  Quote,
  ShieldAlert,
  ShieldCheck,
  Target,
} from "lucide-react"
import { cn } from "cn"
import type { SafetyRisk, ViralClip } from "@/lib/types"
import { scoreTone } from "@/lib/pipeline-ui"

/**
 * The "AI analytics" dropdown on a clip tile.
 *
 * Everything the detection model said about the clip, kept in one expandable
 * strip so the grid stays scannable: the score is always visible on the
 * thumbnail and this is the detail behind it. It is deliberately self-contained -
 * no portal, no popover - so it never overlaps a neighbouring tile.
 */

const SCORE_ROWS: Array<{ key: keyof ViralClip["scores"]; label: string }> = [
  { key: "viral_score", label: "Viral" },
  { key: "retention_score", label: "Retention" },
  { key: "controversy_score", label: "Controversy" },
  { key: "shareability_score", label: "Shareability" },
]

function ScoreRow({ label, value }: { label: string; value: number }) {
  const tone = scoreTone(value)
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full transition-[width] duration-500", tone.fill)}
          style={{ width: `${Math.min(100, Math.max(2, value * 10))}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right text-[11px] font-medium tabular">{value.toFixed(1)}</span>
    </div>
  )
}

function Pill({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "good" | "warn" | "bad"
  children: React.ReactNode
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
        tone === "neutral" && "bg-muted text-muted-foreground ring-border",
        tone === "good" && "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20 dark:text-emerald-300",
        tone === "warn" && "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
        tone === "bad" && "bg-destructive/10 text-destructive ring-destructive/25"
      )}
    >
      {children}
    </span>
  )
}

function riskTone(risk: SafetyRisk): "good" | "warn" | "bad" {
  return risk === "Low" ? "good" : risk === "Medium" ? "warn" : "bad";
}

function Group({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h5 className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase">
        <span className="[&>svg]:size-3">{icon}</span>
        {title}
      </h5>
      {children}
    </section>
  )
}

export interface ClipAnalysisPanelProps {
  analysis?: ViralClip
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ClipAnalysisPanel({ analysis, open, onOpenChange }: ClipAnalysisPanelProps) {
  const [copied, setCopied] = React.useState(false);

  const toggle = () => onOpenChange(!open);

  const copyCaption = async () => {
    if (!analysis) return;
    const text = [
      analysis.viral_packaging.video_title,
      "",
      analysis.viral_packaging.hashtags.join(" "),
    ].join("\n").trim();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (permissions / non-secure origin) - nothing else to do.
    }
  };

  const headline = analysis
    ? `${analysis.scores.viral_score.toFixed(1)} viral score`
    : "no AI analysis stored";

  return (
    <div className="border-t bg-muted/25">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        disabled={!analysis}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] font-medium transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
          analysis ? "hover:bg-muted/60" : "cursor-not-allowed opacity-60",
          open && "bg-muted/40"
        )}
      >
        <BrainCircuit className="size-3.5 shrink-0 text-primary" />
        <span className="shrink-0">AI analytics</span>
        {!open && <span className="min-w-0 flex-1 truncate text-muted-foreground">{headline}</span>}
        {open && <span className="flex-1" />}
        <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && analysis && (
        <div className="animate-fade-in space-y-3 px-3 pt-1 pb-3 text-xs">
          <Group title="Scores" icon={<Gauge />}>
            <div className="space-y-1 rounded-lg bg-card/60 p-2 ring-1 ring-border/60">
              {SCORE_ROWS.map((row) => (
                <ScoreRow key={row.key} label={row.label} value={analysis.scores[row.key]} />
              ))}
            </div>
          </Group>

          {analysis.why_this_will_go_viral && (
            <p className="leading-relaxed text-muted-foreground">{analysis.why_this_will_go_viral}</p>
          )}

          <Group title="Hook line" icon={<Quote />}>
            {analysis.hook_line_analysis.hook_line && (
              <p className="rounded-md border-l-2 border-primary/60 bg-card/60 px-2 py-1.5 leading-relaxed text-foreground/90 italic">
                “{analysis.hook_line_analysis.hook_line}”
              </p>
            )}
            {analysis.hook_line_analysis.why_it_works && (
              <p className="leading-relaxed text-muted-foreground">{analysis.hook_line_analysis.why_it_works}</p>
            )}
          </Group>

          <Group title="Retention & trigger" icon={<Target />}>
            <div className="flex flex-wrap gap-1">
              <Pill>Retention · {analysis.retention_analysis.predicted_retention}</Pill>
              <Pill>Trigger · {analysis.psychological_trigger.dominant_trigger}</Pill>
              <Pill tone={analysis.retention_analysis.open_loop ? "good" : "neutral"}>Open loop</Pill>
              <Pill tone={analysis.retention_analysis.likely_to_watch_till_end ? "good" : "warn"}>
                Watches to end
              </Pill>
            </div>
            {analysis.psychological_trigger.explanation && (
              <p className="leading-relaxed text-muted-foreground">
                {analysis.psychological_trigger.explanation}
              </p>
            )}
          </Group>

          <Group title="Safety" icon={<ShieldCheck />}>
            <div className="flex flex-wrap gap-1">
              <Pill tone={riskTone(analysis.safety_analysis.risk_level)} title={analysis.safety_analysis.monetization_risk}>
                {analysis.safety_analysis.risk_level === "Low" ? (
                  <ShieldCheck className="size-3" />
                ) : (
                  <ShieldAlert className="size-3" />
                )}
                {analysis.safety_analysis.risk_level} risk
              </Pill>
              <Pill tone={analysis.viral_packaging.platform_safe ? "good" : "bad"}>
                Platform safe
              </Pill>
            </div>
            {analysis.safety_analysis.risky_words.length > 0 && (
              <ul className="space-y-1">
                {analysis.safety_analysis.risky_words.map((word, index) => (
                  <li key={`${word.word_or_phrase}-${index}`} className="flex flex-wrap items-center gap-1 text-[11px]">
                    <code className="rounded bg-amber-500/10 px-1 py-0.5 font-medium text-amber-700 dark:text-amber-300">
                      {word.word_or_phrase}
                    </code>
                    <span className="text-muted-foreground">
                      {word.action}
                      {word.safer_replacement ? ` → ${word.safer_replacement}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Group>

          <Group title="Packaging" icon={<Megaphone />}>
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 leading-relaxed font-medium">
                {analysis.viral_packaging.video_title || "—"}
              </p>
              <button
                type="button"
                onClick={copyCaption}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                title="Copy title + hashtags"
              >
                {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
              </button>
            </div>
            {analysis.viral_packaging.hashtags.length > 0 && (
              <p className="text-[11px] leading-relaxed text-primary/80">
                {analysis.viral_packaging.hashtags.join(" ")}
              </p>
            )}
            {analysis.viral_packaging.eligibility_or_reach_concerns && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {analysis.viral_packaging.eligibility_or_reach_concerns}
              </p>
            )}
          </Group>
        </div>
      )}

      {open && !analysis && (
        <p className="px-3 pb-3 text-[11px] text-muted-foreground">
          This clip predates the current analysis format - re-run viral detection to score it.
        </p>
      )}
    </div>
  );
}
