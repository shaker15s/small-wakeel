import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // R17 fix: the dev-tools indicator portal (<nextjs-portal>) floats over the
  // app and EATS clicks meant for real UI (business switcher, model menu,
  // bottom-nav) — the «القايمة مش بتفتح» bug in the preview environment.
  devIndicators: false,
};

export default nextConfig;
