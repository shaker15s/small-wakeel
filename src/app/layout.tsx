import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";

/**
 * Font variables are defined in globals.css as self-hosted system stacks.
 * We deliberately avoid next/font/google: it needs network access at build
 * time (fails in air-gapped installs), sends a third-party request from the
 * user's browser, and its Latin subsets do nothing for Arabic text.
 */
export const metadata: Metadata = {
  title: "وكيل — مساعد شغلك اليومي",
  description: "مساعد ذكي لصحاب المحلات والجيمات والصيدليات والعطارات — سجّل بع صرف بثقة، وكل حاجة موثقة ومتحققة.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7f1" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1a2b" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      {/* suppressHydrationWarning on <body> too: browser extensions
          (bis_status/__processed_* are injected by Brave/Bing/AV extensions)
          rewrite the body attributes and React 19 reports a mismatch the app
          cannot fix. It is console noise, not a bug in our markup. */}
      <body
        className="antialiased bg-background text-foreground"
        suppressHydrationWarning
      >
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={true}>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
