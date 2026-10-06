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
import type { ClipAnalysis, ClipScores, SafetyRisk } from "@/lib/types";

/** m:ss, same style as the clip card's own time labels. */
function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

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
    <section className={cn("mb-4 min-w-0 space-y-2 break-inside-avoid", className)}>
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

/** "Open loop: Yes" chip; nothing when the AI did not say. */
function YesNo({ label, value }: { label: string; value?: boolean }) {
  if (value === undefined) return null;
  return (
    <Badge variant={value ? "success" : "outline"}>
      {label}: {value ? "Yes" : "No"}
    </Badge>
  );
}

function RiskBadge({ risk }: { risk: SafetyRisk }) {
  return (
    <Badge
      variant={risk === "High" ? "destructive" : risk === "Low" ? "success" : "outline"}
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

const SCORE_LABELS: Array<[keyof ClipScores, string]> = [
  ["viral", "Viral"],
  ["retention", "Retention"],
  ["controversy", "Controversy"],
  ["shareability", "Shareability"],
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
          style={{ width: `${Math.min(100, Math.max(0, value * 10))}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Collapsible view of everything the AI said about a clip (the complete
 * `ClipAnalysis`). Closed by default so the card stays compact; renders
 * nothing for clips created before the analysis existed.
 */
export function ClipAnalysisPanel({
  analysis,
}: {
  analysis?: ClipAnalysis | null;
}) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  const toggleId = `${baseId}-toggle`;
  const panelId = `${baseId}-panel`;

  if (!analysis) return null;

  const hook = analysis.hookLineAnalysis ?? {};
  const retention = analysis.retentionAnalysis ?? {};
  const trigger = analysis.psychologicalTrigger ?? {};
  const safety = analysis.safetyAnalysis ?? { riskyWords: [] };
  const packaging = analysis.viralPackaging ?? { hashtags: [], wordsToChange: [] };
  const scores = analysis.scores ?? {};

  const riskyWords = safety.riskyWords ?? [];
  const hashtags = packaging.hashtags ?? [];
  const wordsToChange = packaging.wordsToChange ?? [];

  const scoreRows = SCORE_LABELS.filter(
    ([key]) => typeof scores[key] === "number",
  );
  const riskLines: Array<[string, string | undefined]> = [
    ["Monetization", safety.monetizationRisk],
    ["Reused content", safety.reusedContentRisk],
    ["Algorithm suppression", safety.algorithmSuppressionRisk],
    ["For You feed eligibility", safety.ineligibleForFypRisk],
  ];

  const showHook = Boolean(
    hook.hookLine ||
      hook.hookTimestamp ||
      hook.whyItWorks ||
      hook.placeBeforeClip !== undefined,
  );
  const showRetention = Boolean(
    retention.predictedRetention ||
      retention.curiosityFirst3Seconds ||
      retention.payoffLocation ||
      retention.openLoop !== undefined ||
      retention.likelyToWatchTillEnd !== undefined,
  );
  const showTrigger = Boolean(trigger.dominantTrigger || trigger.explanation);
  const showSafety = Boolean(
    safety.riskLevel ||
      riskyWords.length ||
      riskLines.some(([, value]) => value) ||
      packaging.platformSafe !== undefined,
  );
  const showPackaging = Boolean(
    packaging.hookTextOnVideo ||
      packaging.videoTitle ||
      packaging.ctaText ||
      hashtags.length ||
      wordsToChange.length ||
      packaging.eligibilityOrReachConcerns,
  );

  if (
    !scoreRows.length &&
    !showHook &&
    !showRetention &&
    !showTrigger &&
    !showSafety &&
    !showPackaging
  ) {
    return null;
  }

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
          {scoreRows.length > 0 && (
            <Section
              title="Scores"
              icon={<Gauge />}
              className="sm:[column-span:all]"
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                {scoreRows.map(([key, label]) => (
                  <ScoreBar
                    key={key}
                    label={label}
                    value={scores[key] as number}
                  />
                ))}
              </div>
            </Section>
          )}

          {showHook && (
            <Section title="Hook line" icon={<Quote />}>
              {hook.hookLine && (
                <p className="rounded-md border-l-2 border-primary/60 bg-background/60 px-2.5 py-1.5 leading-relaxed break-words italic">
                  “{hook.hookLine}”
                  {hook.hookTimestamp && (
                    <span className="ml-2 text-muted-foreground not-italic">
                      {formatTime(hook.hookTimestamp.start)} –{" "}
                      {formatTime(hook.hookTimestamp.end)}
                    </span>
                  )}
                </p>
              )}
              {hook.whyItWorks && (
                <Field label="Why it works">{hook.whyItWorks}</Field>
              )}
              <div className="flex flex-wrap gap-1.5">
                <YesNo label="Hook before clip" value={hook.placeBeforeClip} />
              </div>
            </Section>
          )}

          {showRetention && (
            <Section title="Retention" icon={<Target />}>
              {retention.predictedRetention && (
                <Badge variant="secondary">
                  🎯 Predicted: {retention.predictedRetention}
                </Badge>
              )}
              {retention.curiosityFirst3Seconds && (
                <Field label="First 3 seconds">
                  {retention.curiosityFirst3Seconds}
                </Field>
              )}
              {retention.payoffLocation && (
                <Field label="Payoff">{retention.payoffLocation}</Field>
              )}
              <div className="flex flex-wrap gap-1.5">
                <YesNo label="Open loop" value={retention.openLoop} />
                <YesNo
                  label="Watches to the end"
                  value={retention.likelyToWatchTillEnd}
                />
              </div>
            </Section>
          )}

          {showTrigger && (
            <Section title="Psychological trigger" icon={<BrainCircuit />}>
              {trigger.dominantTrigger && (
                <Badge variant="secondary">🧠 {trigger.dominantTrigger}</Badge>
              )}
              {trigger.explanation && <p className="leading-relaxed text-muted-foreground break-words">{trigger.explanation}</p>}
            </Section>
          )}

          {showSafety && (
            <Section title="Safety & eligibility" icon={<ShieldCheck />}>
              <div className="flex flex-wrap gap-1.5">
                {safety.riskLevel && <RiskBadge risk={safety.riskLevel} />}
                <YesNo label="Platform safe" value={packaging.platformSafe} />
              </div>
              {riskLines.map(
                ([label, value]) =>
                  value && (
                    <Field key={label} label={label}>
                      {value}
                    </Field>
                  ),
              )}
              {riskyWords.length > 0 && (
                <div className="space-y-1">
                  <p className="font-medium text-foreground/80">
                    Risky words
                  </p>
                  <ul className="space-y-1">
                    {riskyWords.map((word, index) => (
                      <li
                        key={`${word.wordOrPhrase}-${index}`}
                        className="flex flex-wrap items-center gap-1.5"
                      >
                        <code className="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-400">
                          {word.wordOrPhrase}
                        </code>
                        {word.action && (
                          <Badge variant="outline">{word.action}</Badge>
                        )}
                        {word.saferReplacement && (
                          <span className="text-muted-foreground">
                            → {word.saferReplacement}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Section>
          )}

          {showPackaging && (
            <Section title="Viral packaging" icon={<Megaphone />}>
              {packaging.videoTitle && (
                <Field label="Title">{packaging.videoTitle}</Field>
              )}
              {packaging.hookTextOnVideo && (
                <Field label="Hook text on video">
                  {packaging.hookTextOnVideo}
                </Field>
              )}
              {packaging.ctaText && (
                <Field label="CTA">{packaging.ctaText}</Field>
              )}
              {hashtags.length > 0 && (
                <Field label="Hashtags">{hashtags.join(" ")}</Field>
              )}
              {packaging.eligibilityOrReachConcerns && (
                <Field label="Reach concerns">
                  {packaging.eligibilityOrReachConcerns}
                </Field>
              )}
              {wordsToChange.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-foreground/80">
                    Words to change:
                  </span>
                  {wordsToChange.map((word, index) => (
                    <Badge key={`${word}-${index}`} variant="outline">
                      {word}
                    </Badge>
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
