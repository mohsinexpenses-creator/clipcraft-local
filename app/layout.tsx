import type { Metadata } from 'next';
import './globals.css';
import { Navbar } from '@/components/navbar';
import { ThemeProvider } from '@/components/theme-provider';

export const metadata: Metadata = {
  title: 'ClipCraft Local - Personal AI Clip Generator',
  description:
    'Convert landscape long-form videos into viral 9:16 portrait short clips with smart crop, color filters, intro hook, and animated captions.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col bg-background font-sans text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <Navbar />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-8">
            {children}
          </main>
          <footer className="border-t py-6 text-center text-xs text-muted-foreground">
            ClipCraft Local — Personal AI Short-Form Video Generator
          </footer>
        </ThemeProvider>
      </body>
    </html>
  );
}
