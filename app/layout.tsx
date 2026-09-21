import type { Metadata } from 'next';
import './globals.css';
import { Navbar } from '@/components/navbar';

export const metadata: Metadata = {
  title: 'ClipCraft Local - Personal AI Clip Generator',
  description: 'Convert landscape long-form videos into viral 9:16 portrait short clips with smart crop, color filters, intro hook, and animated captions.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased flex flex-col font-sans">
        <Navbar />
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
        <footer className="border-t border-slate-900 bg-slate-950 py-6 text-center text-xs text-slate-600">
          ClipCraft Local • Personal AI Short-Form Video Generator • Node.js / TypeScript Stack
        </footer>
      </body>
    </html>
  );
}
