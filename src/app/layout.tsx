/**
 * Root layout for the whole Next.js app.
 *
 * Renders the HTML shell that wraps every route: Google fonts (Geist +
 * Geist Mono) as CSS variables, the global stylesheet, a class-attribute
 * theme provider (light/dark/system, persisted by next-themes) and the
 * toast notification host.
 *
 * Client-side database and sync-service concerns live in page components
 * (REST via src/lib/db-backed routes, live editing against the socket.io
 * sync service on port 3003); this file is presentation-only.
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/codoc/theme-provider";

// Loaded once per request tree; exposed as CSS variables so globals.css
// and Tailwind utilities can reference both typefaces.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CoDoc — Real-time collaborative Markdown editor",
  description:
    "A mini Google Docs for Markdown: live cursors, presence, server-authoritative operational-transform sync and a version timeline, built with Next.js, socket.io and PostgreSQL.",
  // Favicon is served by the Next.js file convention (src/app/favicon.ico);
  // no `icons` entry needed — a custom one here would override it.
};

// suppressHydrationWarning: next-themes mutates <html class> before
// hydration to apply the persisted theme, which React would otherwise
// flag as a mismatch.
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
