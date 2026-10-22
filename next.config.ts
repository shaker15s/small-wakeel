import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Origins allowed to EMBED the app in an iframe.
 *
 * Security default is «nobody»: `frame-ancestors 'self'` plus
 * `X-Frame-Options: DENY` stops clickjacking, which matters because an agent
 * UI can approve money operations with one tap.
 *
 * Hosted previews (Arena/E2B sandboxes, Vercel previews, a shop's intranet
 * dashboard) legitimately need to frame it, so embedding is opt-in:
 *   • in development the preview wildcard `https://*.e2b.app` is allowed
 *   • any deployment can allow its own embedders via WAKIL_EMBED_ORIGINS
 *     (comma-separated absolute origins, e.g. "https://dash.myshop.eg")
 * `X-Frame-Options` is omitted whenever a wildcard embedder is allowed, because
 * the header has no wildcard syntax — CSP frame-ancestors is the modern control
 * and both browsers and the sandbox honour it.
 */
function embedOrigins(): string[] {
  const fromEnv = (process.env.WAKIL_EMBED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // `*` lets an operator opt into total embedding (public demo builds only).
  if (fromEnv.includes("*")) return ["*"];
  return isDev ? ["https://*.e2b.app", ...fromEnv] : fromEnv;
}

/**
 * Content-Security-Policy.
 *
 * Next's App Router injects inline bootstrap scripts and Tailwind/framer-motion
 * write inline styles, so 'unsafe-inline' is required for script/style unless a
 * nonce pipeline is added. Everything else is locked down: no remote script,
 * image or connect origins — the agent's LLM traffic stays server-side, so the
 * browser never needs to reach a model provider directly.
 */
function buildCsp(): string {
  const embeds = embedOrigins()
  const frameAncestors = ["'self'", ...embeds].join(" ")
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ")
}

/**
 * Dev-server origins that may load Next's dev resources (HMR, /_next/*).
 *
 * Next 16 blocks cross-origin dev-resource requests by default, which silently
 * broke the hosted preview: the page loaded but HMR/asset requests from
 * `https://<port>-<sandbox>.e2b.app` were refused («Blocked cross-origin request
 * to Next.js dev resource /_next/hmr»). The preview host is dynamic, so the
 * wildcard pattern is required. Production builds ignore this option entirely.
 */
function allowedDevOrigins(): string[] {
  const fromEnv = (process.env.WAKIL_DEV_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return ["*.e2b.app", "*.preview.app", ...fromEnv];
}

const nextConfig: NextConfig = {
  output: "standalone",
  // Maintenance CLIs are built separately and keep @libsql/client external.
  // Since the web app no longer imports that package directly, Next's tracer
  // can omit it from standalone/node_modules even though the maintenance
  // bundles need it at runtime. Include its package tree in standalone output
  // so packaged migrate/db-snapshot jobs do not fail with MODULE_NOT_FOUND.
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/@libsql/client/**/*",
      "./node_modules/@libsql/core/**/*",
      "./node_modules/@libsql/hrana-client/**/*",
      "./node_modules/@libsql/isomorphic-ws/**/*",
      "./node_modules/libsql/**/*",
    ],
  },
  // Hosted-preview support: without this, Next 16 refuses HMR/dev-asset loads
  // coming from the sandbox proxy host and the live preview misbehaves.
  ...(isDev ? { allowedDevOrigins: allowedDevOrigins() } : {}),
  // Type errors FAIL the build. They were silenced before
  // (`ignoreBuildErrors: true`), which is how broken code reached production.
  // (Next 16 dropped the built-in `eslint` build step — `bun run lint` owns it.)
  typescript: { ignoreBuildErrors: false },
  reactStrictMode: false,
  // The agent runs the SQLite driver adapter in-process; these must stay
  // external so their native bindings are traced into the standalone build
  // instead of being bundled by Turbopack/webpack.
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-libsql", "@libsql/client", "libsql"],
  // R17 fix: the dev-tools indicator portal (<nextjs-portal>) floats over the
  // app and EATS clicks meant for real UI (business switcher, model menu,
  // bottom-nav) — the «القايمة مش بتفتح» bug in the preview environment.
  devIndicators: false,
  poweredByHeader: false,
  async headers() {
    const embeds = embedOrigins()
    const wildcardEmbed = embeds.includes("*") || embeds.some((o) => o.includes("*"))
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: buildCsp() },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // X-Frame-Options has no wildcard form; skip it when CSP already
          // names the allowed embedders (CSP takes precedence in every modern
          // browser and is what the sandbox preview checks).
          ...(wildcardEmbed ? [] : [{ key: "X-Frame-Options", value: "DENY" }]),
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=(), payment=()",
          },
          ...(isDev
            ? []
            : [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]),
        ],
      },
      {
        // API responses are per-tenant data: never cache them anywhere.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
