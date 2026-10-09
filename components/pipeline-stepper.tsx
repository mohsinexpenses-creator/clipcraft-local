"use client"

import * as React from "react"
import {
  AlertTriangle,
  Check,
  CircleDashed,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Scissors,
  Sparkles,
  TextCursorInput,
} from "lucide-react"
import { cn } from "cn"
import type { PipelineStatus, PipelineStep } from "@/lib/pipeline-status"
import { formatDuration, stageMeta } from "@/lib/pipeline-ui"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * The three automatic steps, as one strip: what ran, what is running now and
 * what is left. Because the state is derived server-side from the queue and the
 * clip rows, this component never needs to "know" the workflow - it just draws
 * what it is handed.
 */

const STEP_ICONS = {
  transcript: TextCursorInput,
  analyze: Sparkles,
  render: Scissors,
} as const

function StepIcon({ step }: { step: PipelineStep }) {
  const Icon = STEP_ICONS[step.key] ?? CircleDashed

  switch (step.state) {
    case "done":
      return (
        <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )
    case "active":
      return (
        <span className="relative flex size-7 items-center justify-center rounded-full bg-primary/12 text-primary ring-1 ring-primary/30">
          {/* Soft halo so "running" reads at a glance across the whole card. */}
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-primary/15" />
          <Loader2 className="size-3.5 animate-spin" />
        </span>
      )
    case "failed":
      return (
        <span className="flex size-7 items-center justify-center rounded-full bg-destructive/12 text-destructive ring-1 ring-destructive/30">
          <AlertTriangle className="size-3.5" />
        </span>
      )
    case "paused":
      return (
        <span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
          <Pause className="size-3.5" />
        </span>
      )
    default:
      return (
        <span className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground/70 ring-1 ring-border">
          <Icon className="size-3.5" />
        </span>
      )
  }
}

export interface PipelineStepperProps {
  status: PipelineStatus
  busy?: boolean
  onResume?: () => void
  onRetryStep?: (step: PipelineStep) => void
}

export function PipelineStepper({ status, busy, onResume, onRetryStep }: PipelineStepperProps) {
  const meta = stageMeta(status.stage)
  const resumable = status.stage === "failed" || status.stage === "awaiting-detection" || status.stage === "awaiting-render";
  const stuck = status.stage === "queued" || status.stage === "awaiting-detection" || status.stage === "failed";

  return (
    <div
      className={cn(
        "rounded-2xl border bg-card/70 p-1.5 shadow-[var(--shadow-card)] backdrop-blur-sm"
      )}
    >
      <div className="flex flex-col gap-1.5 lg:flex-row lg:items-stretch">
        <div className="grid flex-1 grid-cols-1 gap-1.5 sm:grid-cols-3">
          {status.steps.map((step, index) => (
            <div
              key={step.key}
              className={cn(
                "group relative flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors",
                step.state === "active" && "bg-accent/60",
                step.state === "failed" && "bg-destructive/5",
                step.state !== "active" && step.state !== "failed" && "hover:bg-muted/60"
              )}
            >
              {/* Connector rail between the step markers. */}
              {index > 0 && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-6 -left-1.5 hidden h-px w-3 bg-border sm:block"
                  )}
                />
              )}
              <StepIcon step={step} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[13px] leading-tight font-medium">{step.label}</p>
                  {step.state === "active" && (
                    <span className="shrink-0 text-[11px] tabular text-muted-foreground">
                      {step.progress}%
                    </span>
                  )}
                  {step.state === "done" && (
                    <span className="shrink-0 text-[11px] text-primary">done</span>
                  )}
                </div>
                <p
                  className={cn(
                    "mt-0.5 truncate text-[11px] leading-tight",
                    step.state === "failed" ? "text-destructive" : "text-muted-foreground"
                  )}
                  title={step.error ?? step.detail}
                >
                  {step.error ?? step.detail ?? (step.state === "pending" ? "Waiting" : "—")}
                </p>
                {step.durationMs !== undefined && step.state !== "pending" && (
                  <p
                    className={cn(
                      "mt-0.5 flex items-center gap-1 text-[10.5px] tabular",
                      step.state === "active" ? "text-primary/80" : "text-muted-foreground"
                    )}
                    title={
                      step.state === "active"
                        ? "Elapsed time so far (updates live)"
                        : "Time this step took"
                    }
                  >
                    <Clock className="size-3" />
                    {step.state === "active" ? "running " : ""}
                    {formatDuration(step.durationMs)}
                  </p>
                )}
                {step.state === "active" && (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full transition-[width] duration-500 ease-out", meta.bar)}
                      style={{ width: `${Math.max(3, step.progress)}%` }}
                    />
                  </div>
                )}
              </div>
              {step.state === "failed" && onRetryStep && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="shrink-0 self-center"
                        onClick={() => onRetryStep(step)}
                        disabled={Boolean(busy)}
                        aria-label={`Retry ${step.label}`}
                      />
                    }
                  >
                    <RefreshCw className={cn(busy ? "animate-spin" : undefined)} />
                  </TooltipTrigger>
                  <TooltipContent>Retry this step</TooltipContent>
                </Tooltip>
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3.5 py-2.5 lg:w-64 lg:flex-col lg:items-start lg:justify-center">
          <div className="min-w-0">
            <p className="text-[11px] tracking-wide text-muted-foreground uppercase">Overall</p>
            <p className={cn("mt-0.5 flex items-center gap-1.5 text-sm font-semibold", meta.pulse && "text-primary")}>
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", meta.bar, meta.pulse && "animate-pulse")}
              />
              {meta.label}
            </p>
            {status.timings.totalMs !== undefined && (
              <p
                className="mt-0.5 flex items-center gap-1 text-[11px] tabular text-muted-foreground"
                title="Total pipeline time: from the first step that started to the last one that finished (grows live while a step runs)"
              >
                <Clock className="size-3" />
                {formatDuration(status.timings.totalMs)}
              </p>
            )}
          </div>
          <div className="flex flex-1 items-center gap-2 lg:w-full lg:flex-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-background lg:w-32">
              <div
                className={cn("h-full rounded-full transition-[width] duration-700 ease-out", meta.bar, meta.pulse && "progress-live")}
                style={{ width: `${Math.max(2, status.progress)}%` }}
              />
            </div>
            <span className="shrink-0 text-[11px] tabular text-muted-foreground">{status.progress}%</span>
          </div>
          {(resumable || stuck) && onResume && (
            <Button
              size="sm"
              variant={stuck ? "default" : "outline"}
              onClick={onResume}
              disabled={Boolean(busy)}
              className="shrink-0"
            >
              {busy ? <Loader2 className="animate-spin" /> : stuck ? <Play /> : <RefreshCw />}
              {status.stage === "failed" ? "Retry" : "Resume"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
