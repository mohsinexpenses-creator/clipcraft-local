"use client"

import * as React from "react"
import { ArrowLeftRight, ImageOff, Images, Loader2, RefreshCw, Trash2 } from "lucide-react"
import type { BrollItem, BrollPlan } from "@/lib/types"
import { Button } from "@/components/ui/button"

/**
 * The B-roll plan for one clip, shown ON the clip tile.
 *
 * The clip grid is the only review surface for B-roll (no page-level dialog): each
 * image is a thumbnail with its type, its time range and its attribution, plus
 * two actions - swap (to the next verified candidate) and remove. "Re-run" plans
 * the clip again from scratch.
 */

const PROVIDER_LABEL: Record<BrollItem["attribution"]["provider"], string> = {
  wikimedia: "Wikimedia Commons",
  pexels: "Pexels",
  pixabay: "Pixabay",
  unsplash: "Unsplash",
}

export interface BrollPlanPanelProps {
  plan: BrollPlan | null
  status?: "none" | "pending" | "running" | "done" | "failed"
  error?: string
  busy?: boolean
  onRerun: () => void
  onSwap: (itemId: string) => void
  onRemove: (itemId: string) => void
}

function timeLabel(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return minutes > 0 ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}` : `${rest.toFixed(1)}s`
}

export function BrollPlanPanel({
  plan,
  status = "none",
  error,
  busy,
  onRerun,
  onSwap,
  onRemove,
}: BrollPlanPanelProps) {
  const [open, setOpen] = React.useState(false)
  const items = plan?.items ?? []
  const running = status === "pending" || status === "running"
  const failed = status === "failed"

  return (
    <div className="mt-2 rounded-xl border bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium">
          <Images className="size-3.5 shrink-0 text-muted-foreground" />
          B-roll
          {running ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              planning…
            </span>
          ) : failed ? (
            <span className="text-destructive">failed</span>
          ) : plan ? (
            <span className="text-muted-foreground">
              {items.length} image{items.length === 1 ? "" : "s"}
              {plan.counts.fullscreen ? ` · ${plan.counts.fullscreen} full-screen` : ""}
              {plan.counts.landscape ? ` · ${plan.counts.landscape} card${plan.counts.landscape === 1 ? "" : "s"}` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground">not planned</span>
          )}
        </span>
        <span className="text-[10.5px] text-muted-foreground">{open ? "Hide" : "Review"}</span>
      </button>

      {open ? (
        <div className="space-y-2 border-t px-2.5 py-2">
          {error ? (
            <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-[10.5px] leading-snug text-destructive">
              {error}
            </p>
          ) : null}

          {plan && items.length > 0 ? (
            <ul className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {items.map((item) => {
                const showFull = item.kind === "fullscreen"
                const label = item.entityName ?? item.query
                return (
                  <li
                    key={item.id}
                    className="overflow-hidden rounded-lg border bg-background"
                    title={`${label} · ${timeLabel(item.start)}–${timeLabel(item.end)}`}
                  >
                    <div className="relative aspect-[16/10] bg-muted">
                      {/* The prepared frame, straight from the B-roll cache. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/broll-media/${encodeURIComponent(item.renderFile)}`}
                        alt={label}
                        className="size-full object-cover"
                        loading="lazy"
                      />
                      <span className="absolute top-1 left-1 rounded bg-background/85 px-1 text-[9px] font-medium">
                        {showFull ? "Full" : "Card"}
                      </span>
                    </div>
                    <div className="space-y-0.5 p-1.5">
                      <p className="truncate text-[10px] font-medium">{label}</p>
                      <p className="text-[9.5px] text-muted-foreground tabular-nums">
                        {timeLabel(item.start)}–{timeLabel(item.end)}
                      </p>
                      <p className="truncate text-[9px] text-muted-foreground">
                        {item.attribution.author ?? PROVIDER_LABEL[item.attribution.provider]}
                        {item.attribution.license ? ` · ${item.attribution.license}` : ""}
                      </p>
                      <div className="flex items-center justify-between gap-1 pt-0.5">
                        <a
                          href={item.attribution.sourceUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="truncate text-[9px] text-primary underline-offset-2 hover:underline"
                        >
                          source
                        </a>
                        <div className="flex items-center">
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Swap ${label}`}
                            title="Swap to the next verified image"
                            disabled={busy || !item.alternatives?.length}
                            onClick={() => onSwap(item.id)}
                          >
                            <ArrowLeftRight className="size-3" />
                          </Button>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Remove ${label}`}
                            title="Remove this image"
                            disabled={busy}
                            onClick={() => onRemove(item.id)}
                          >
                            <Trash2 className="size-3" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="flex items-start gap-1.5 rounded-md bg-background px-2 py-1.5 text-[10.5px] leading-snug text-muted-foreground">
              <ImageOff className="mt-0.5 size-3 shrink-0" />
              {plan
                ? "No image passed the checks for this clip. The reasons are below."
                : "No plan yet for this clip."}
            </p>
          )}

          {plan ? (
            <div className="flex flex-wrap items-center justify-between gap-1.5">
              <p className="text-[9.5px] text-muted-foreground">
                Target {plan.counts.targetMin}–{plan.counts.targetMax} · kept out of the{" "}
                {plan.hookDuration > 0 ? `${plan.hookDuration.toFixed(1)}s hook` : "hook"}
              </p>
              <Button size="xs" variant="outline" onClick={onRerun} disabled={busy || running}>
                {busy || running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Re-run B-roll
              </Button>
            </div>
          ) : (
            <Button size="xs" variant="outline" onClick={onRerun} disabled={busy || running}>
              {busy || running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Plan B-roll now
            </Button>
          )}

          {plan && plan.skipped.length > 0 ? (
            <details className="rounded-md bg-background px-2 py-1.5">
              <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">
                {plan.skipped.length} skipped item{plan.skipped.length === 1 ? "" : "s"} — why
              </summary>
              <ul className="mt-1 space-y-0.5">
                {plan.skipped.slice(0, 12).map((skip, index) => (
                  <li key={`${skip.stage}-${index}`} className="text-[9.5px] leading-snug text-muted-foreground">
                    <span className="font-medium text-foreground/80">{skip.stage}</span>
                    {skip.entity ? ` · ${skip.entity}` : ""}: {skip.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
