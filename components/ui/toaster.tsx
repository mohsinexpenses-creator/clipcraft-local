"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react"
import { cn } from "cn"

/**
 * A ~60-line toast system: the pipeline runs unattended, so the feedback that
 * matters is "your action was accepted" and "this step failed", not a modal you
 * have to click away. Toasts stack bottom-right, auto-dismiss, and are announced
 * through a polite live region.
 */

export type ToastTone = "info" | "success" | "error"

export interface Toast {
  id: number
  title: string
  description?: string
  tone: ToastTone
  /** ms; 0 keeps it until dismissed. */
  duration: number
}

interface ToastContextValue {
  toasts: Toast[]
  toast: (input: { title: string; description?: string; tone?: ToastTone; duration?: number }) => number
  dismiss: (id: number) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

const TONE_STYLE: Record<ToastTone, { icon: React.ReactNode; ring: string; text: string }> = {
  info: {
    icon: <Info className="size-4" />,
    ring: "ring-border",
    text: "text-foreground/80",
  },
  success: {
    icon: <CheckCircle2 className="size-4" />,
    ring: "ring-emerald-500/25",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  error: {
    icon: <AlertCircle className="size-4" />,
    ring: "ring-destructive/30",
    text: "text-destructive",
  },
}

let nextToastId = 1

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const toast = React.useCallback<ToastContextValue["toast"]>(
    ({ title, description, tone = "info", duration }) => {
      const id = nextToastId++
      const effectiveDuration = duration ?? (tone === "error" ? 9000 : 4500)
      setToasts((current) => [
        ...current.slice(-3),
        { id, title, tone, duration: effectiveDuration, ...(description ? { description } : {}) },
      ])
      if (effectiveDuration > 0) {
        timers.current.set(id, setTimeout(() => dismiss(id), effectiveDuration))
      }
      return id
    },
    [dismiss],
  )

  React.useEffect(() => {
    const map = timers.current
    return () => {
      for (const timer of map.values()) clearTimeout(timer)
      map.clear()
    }
  }, [])

  const value = React.useMemo(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed right-0 bottom-0 z-[60] flex w-full max-w-sm flex-col gap-2 p-4 sm:p-6"
      >
        {toasts.map((item) => {
          const tone = TONE_STYLE[item.tone]
          return (
            <div
              key={item.id}
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-xl border bg-card/95 p-3.5 text-card-foreground shadow-[var(--shadow-lift)] ring-1 backdrop-blur-sm",
                "animate-fade-up",
                tone.ring,
              )}
            >
              <span className={cn("mt-0.5 shrink-0", tone.text)}>{tone.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug font-medium">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                aria-label="Dismiss notification"
                className="-mt-0.5 -mr-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const context = React.useContext(ToastContext)
  if (!context) throw new Error("useToast must be used inside <Toaster>")
  return context
}
