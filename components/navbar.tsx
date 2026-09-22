'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clapperboard, LayoutGrid, MessageSquareText, SlidersHorizontal, Upload } from 'lucide-react';
import { cn } from 'cn';
import { ModeToggle } from '@/components/theme-toggle';

const navItems = [
  { label: 'Dashboard', href: '/', icon: LayoutGrid },
  { label: 'Upload', href: '/upload', icon: Upload },
  { label: 'Caption Presets', href: '/caption-presets', icon: SlidersHorizontal },
  { label: 'Prompts', href: '/prompt-templates', icon: MessageSquareText },
];

export const Navbar = () => {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Clapperboard className="size-4" />
          </div>
          <span className="hidden text-sm font-semibold tracking-tight text-foreground sm:block">
            ClipCraft Local
          </span>
        </Link>

        <nav className="flex items-center gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <Icon className="size-4" />
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <ModeToggle />
      </div>
    </header>
  );
};
