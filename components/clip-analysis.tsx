"use client";

import React, { useId, useState } from "react";
import {
  BrainCircuit,
  ChevronDown,
  Gauge,
  Megaphone,
  Quote,
  ShieldAlert,
  ShieldCheck,
  Target,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { SafetyRisk, ViralClip } from "@/lib/types";

function Section({
  title,
  icon,
  className,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn("mb-4 min-w-0 space-y-2 break-inside-avoid", className)}
    >
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground [&>svg]:size-3.5">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <p className="leading-relaxed break-words">
      <span className="font-medium text-foreground/80">{label}: </span>
      <span className="text-muted-foreground">{children}</span>
    </p>
  );
}

function YesNo({ label, value }: { label: string; value: boolean }) {
  return (
    <Badge variant={value ? "success" : "outline"}>
      {label}: {value ? "Yes" : "No"}
    </Badge>
  );
}

function RiskBadge({ risk }: { risk: SafetyRisk }) {
  return (
    <Badge
      variant={
        risk === "High" ? "destructive" : risk === "Low" ? "success" : "outline"
      }
      className={
        risk === "Medium"
          ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
          : undefined
      }
    >
      {risk === "Low" ? <ShieldCheck /> : <ShieldAlert />}
      {risk} risk
    </Badge>
  );
}

const SCORE_LABELS: Array<[keyof ViralClip["scores"], string]> = [
  ["viral_score", "Viral"],
  ["retention_score", "Retention"],
  ["controversy_score", "Controversy"],
  ["shareability_score", "Shareability"],
];

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums text-foreground/80">
          {Number.isInteger(value) ? value : value.toFixed(1)}/10
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${label} score`}
        aria-valuemin={0}
        aria-valuemax={10}
        aria-valuenow={value}
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${value * 10}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Collapsible view of everything the AI said about a clip (the stored
 * `ViralClip`). Closed by default so the card stays compact; renders nothing
 * for clips created before the new AI schema.
 */
export function ClipAnalysisPanel({ analysis }: { analysis?: ViralClip }) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const toggleId = `${baseId}-toggle`;
  const panelId = `${baseId}-panel`;

  if (!analysis) return null;

  const {
    hook_line_analysis: hook,
    retention_analysis: retention,
    psychological_trigger: trigger,
    safety_analysis: safety,
    viral_packaging: packaging,
    scores,
  } = analysis;

  const riskLines: Array<[string, string]> = [
    ["Monetization", safety.monetization_risk],
    ["Reused content", safety.reused_content_risk],
    ["Algorithm suppression", safety.algorithm_suppression_risk],
    ["For You feed eligibility", safety.ineligible_for_fyf_risk],
  ];

  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-muted/30">
      <button
        id={toggleId}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex items-center gap-1.5">
          <BrainCircuit className="size-3.5 text-primary" />
          AI analysis
        </span>
        <span className="flex items-center gap-2 font-normal text-muted-foreground">
          <span className="hidden sm:inline">
            Hook · Retention · Trigger · Safety · Packaging · Scores
          </span>
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-labelledby={toggleId}
          className="border-t px-3 py-3 text-xs sm:columns-2 sm:gap-x-6"
        >
          <Section
            title="Scores"
            icon={<Gauge />}
            className="sm:[column-span:all]"
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              {SCORE_LABELS.map(([key, label]) => (
                <ScoreBar key={key} label={label} value={scores[key]} />
              ))}
            </div>
          </Section>

          <Section title="Hook line" icon={<Quote />}>
            {hook.hook_line && (
              <p className="rounded-md border-l-2 border-primary/60 bg-background/60 px-2.5 py-1.5 leading-relaxed break-words italic">
                “{hook.hook_line}”
                <span className="ml-2 text-muted-foreground not-italic">
                  {hook.hook_timestamp.start} – {hook.hook_timestamp.end}
                </span>
              </p>
            )}
            {hook.why_it_works && (
              <Field label="Why it works">{hook.why_it_works}</Field>
            )}
            <div className="flex flex-wrap gap-1.5">
              <YesNo label="Hook before clip" value={hook.place_before_clip} />
            </div>
          </Section>

          <Section title="Retention" icon={<Target />}>
            <Badge variant="secondary">
              🎯 Predicted: {retention.predicted_retention}
            </Badge>
            {retention.curiosity_first_3_seconds && (
              <Field label="First 3 seconds">
                {retention.curiosity_first_3_seconds}
              </Field>
            )}
            {retention.payoff_location && (
              <Field label="Payoff">{retention.payoff_location}</Field>
            )}
            <div className="flex flex-wrap gap-1.5">
              <YesNo label="Open loop" value={retention.open_loop} />
              <YesNo
                label="Watches to the end"
                value={retention.likely_to_watch_till_end}
              />
            </div>
          </Section>

          <Section title="Psychological trigger" icon={<BrainCircuit />}>
            <Badge variant="secondary">🧠 {trigger.dominant_trigger}</Badge>
            {trigger.explanation && (
              <p className="leading-relaxed text-muted-foreground break-words">
                {trigger.explanation}
              </p>
            )}
          </Section>

          <Section title="Safety & eligibility" icon={<ShieldCheck />}>
            <div className="flex flex-wrap gap-1.5">
              <RiskBadge risk={safety.risk_level} />
              <YesNo label="Platform safe" value={packaging.platform_safe} />
            </div>
            {riskLines.map(
              ([label, value]) =>
                value && (
                  <Field key={label} label={label}>
                    {value}
                  </Field>
                ),
            )}
            {safety.risky_words.length > 0 && (
              <div className="space-y-1">
                <p className="font-medium text-foreground/80">Risky words</p>
                <ul className="space-y-1">
                  {safety.risky_words.map((word, index) => (
                    <li
                      key={`${word.word_or_phrase}-${index}`}
                      className="flex flex-wrap items-center gap-1.5"
                    >
                      <code className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                        {word.word_or_phrase}
                      </code>
                      <Badge variant="outline">{word.action}</Badge>
                      {word.safer_replacement && (
                        <span className="text-muted-foreground">
                          → {word.safer_replacement}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <Section title="Viral packaging" icon={<Megaphone />}>
            {packaging.video_title && (
              <Field label="Title">{packaging.video_title}</Field>
            )}
            {packaging.hook_text_on_video && (
              <Field label="Hook text on video">
                {packaging.hook_text_on_video}
              </Field>
            )}
            {packaging.cta_text && (
              <Field label="CTA">{packaging.cta_text}</Field>
            )}
            {packaging.hashtags.length > 0 && (
              <Field label="Hashtags">{packaging.hashtags.join(" ")}</Field>
            )}
            {packaging.eligibility_or_reach_concerns && (
              <Field label="Reach concerns">
                {packaging.eligibility_or_reach_concerns}
              </Field>
            )}
            {packaging.words_to_change.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-foreground/80">
                  Words to change:
                </span>
                {packaging.words_to_change.map((word, index) => (
                  <Badge key={`${word}-${index}`} variant="outline">
                    {word}
                  </Badge>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
