import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { AmbientBackground } from "@/components/app/AmbientBackground";
import { ThemeProvider } from "next-themes";

export const metadata: Metadata = {
  title: "وكيل — مساعد شغلك اليومي",
  description: "مساعد ذكي لصحاب المحلات والجيمات والصيدليات والعطارات — سجّل بع صرف بثقة، وكل حاجة موثقة ومتحققة.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7f1" },
    { media: "(prefers-color-scheme: dark)", color: "#101318" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

const FETCH_EXTENSION_GUARD_SCRIPT = `
(function() {
  try {
    var patchTarget = function(target) {
      if (!target) return;
      var desc = Object.getOwnPropertyDescriptor(target, 'fetch');
      if (!desc || !desc.configurable) return;
      if (desc.get && !desc.set) {
        var origGet = desc.get;
        var overrideFetch = null;
        Object.defineProperty(target, 'fetch', {
          configurable: true,
          enumerable: desc.enumerable !== false,
          get: function() {
            return overrideFetch || origGet.call(this);
          },
          set: function(fn) {
            if (typeof fn === 'function') overrideFetch = fn;
          }
        });
      } else if (desc.writable === false && 'value' in desc) {
        Object.defineProperty(target, 'fetch', {
          configurable: true,
          enumerable: desc.enumerable !== false,
          writable: true,
          value: desc.value
        });
      }
    };
    patchTarget(window);
    if (typeof Window !== 'undefined' && Window.prototype) {
      patchTarget(Window.prototype);
    }
  } catch (_) {}

  window.addEventListener('error', function(ev) {
    try {
      var msg = String((ev && ev.message) || '');
      var file = String((ev && ev.filename) || '');
      if (
        msg.indexOf('Cannot set property fetch') !== -1 ||
        file.indexOf('chrome-extension://') !== -1 ||
        file.indexOf('moz-extension://') !== -1
      ) {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return false;
      }
    } catch (_) {}
  }, true);
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head suppressHydrationWarning>
        <script
          id="wakil-fetch-extension-guard"
          dangerouslySetInnerHTML={{ __html: FETCH_EXTENSION_GUARD_SCRIPT }}
        />
      </head>
      <body
        suppressHydrationWarning
        className="antialiased bg-background text-foreground"
      >
        <AmbientBackground />
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={true}>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}

