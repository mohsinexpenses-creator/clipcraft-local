"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Clapperboard,
  LayoutDashboard,
  Menu,
  MessageSquareText,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ModeToggle } from "@/components/theme-toggle"

/**
 * The application frame: a persistent sidebar on wide screens, a slide-over on
 * small ones. Everything the app does is reached from here, so individual pages
 * no longer need their own header rows or back links.
 */

const NAV_ITEMS = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard, hint: "Videos, pipeline and clips" },
  { label: "Upload", href: "/upload", icon: Upload, hint: "Start a new pipeline" },
  {
    label: "Caption presets",
    href: "/caption-presets",
    icon: SlidersHorizontal,
    hint: "Caption, hook and CTA styles",
  },
  { label: "Prompts", href: "/prompt-templates", icon: MessageSquareText, hint: "AI prompt templates" },
  { label: "Startup check", href: "/startup-validation", icon: ShieldCheck, hint: "Verify binaries and keys" },
] as const

function Brand() {
  return (
    <Link
      href="/"
      className="group flex items-center gap-2.5 rounded-lg px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      <span className="relative flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-transform group-hover:-rotate-3">
        <Clapperboard className="size-4.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold tracking-tight">ClipCraft</span>
        <span className="block truncate text-[11px] text-muted-foreground">Local AI clip studio</span>
      </span>
    </Link>
  )
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-0.5" aria-label="Main">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const isActive = pathname === item.href
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            title={item.hint}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring/40",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {/* Active marker: a 2px rail instead of a heavy box. */}
            <span
              aria-hidden
              className={cn(
                "absolute top-1.5 bottom-1.5 -left-2 w-0.5 rounded-full bg-primary transition-opacity",
                isActive ? "opacity-100" : "opacity-0",
              )}
            />
            <Icon className={cn("size-4 shrink-0 transition-transform group-hover:scale-110")} />
            <span className="truncate">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = React.useState(false)

  return (
    <div className="flex min-h-screen w-full">
      {/* Static sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-sidebar px-4 py-5 text-sidebar-foreground lg:flex">
        <Brand />
        <div className="mt-6 flex-1">
          <NavLinks />
        </div>
        <div className="flex items-center justify-between gap-2 border-t pt-4">
          <p className="text-[11px] leading-tight text-muted-foreground">
            Everything runs on this machine
          </p>
          <ModeToggle />
        </div>
      </aside>

      {/* Mobile bar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b bg-background/85 px-4 backdrop-blur-md lg:hidden">
          <Brand />
          <div className="flex items-center gap-1.5">
            <ModeToggle />
            <Button
              variant="outline"
              size="icon-lg"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu />
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1">
          <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>

        <footer className="border-t px-4 py-5 text-[11px] text-muted-foreground sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center justify-between gap-2">
            <span>ClipCraft Local — personal AI short-form generator</span>
            <span>
              Made with{" "}
              <span className="text-destructive">♥</span> by{" "}
              <Link
                href="https://nawab-tech.vercel.app/about"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground/70 underline-offset-4 hover:text-primary hover:underline"
              >
                Nawab Tech
              </Link>
            </span>
          </div>
        </footer>
      </div>

      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent className="top-0 right-0 left-auto h-dvh max-h-dvh w-[min(20rem,88vw)] translate-y-0 rounded-none p-5 data-open:slide-in-from-right data-closed:slide-out-to-right" showCloseButton={false}>
          <div className="flex items-center justify-between">
            <Brand />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
            >
              <X />
            </Button>
          </div>
          <div className="mt-6">
            <NavLinks onNavigate={() => setMobileOpen(false)} />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
