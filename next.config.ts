import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy.
 *
 * Next's App Router injects inline bootstrap scripts, and Tailwind/framer-motion
 * write inline styles, so 'unsafe-inline' is required for script/style unless a
 * nonce pipeline is added. Everything else is locked down: no remote script or
 * image origins, no framing, no form posts off-origin. `connect-src 'self'`
 * keeps the agent's LLM traffic server-side (the browser only talks to us).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors and lint errors now FAIL the build. They were silenced before
  // (`ignoreBuildErrors: true`), which is how broken code reached production.
  // (Next 16 dropped the built-in `eslint` build step — `bun run lint` in CI owns it.)
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
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
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
