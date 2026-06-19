import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // Pre-existing react-hooks lint debt from the Renaissance fork (new React 19 /
  // Next 16 rules). Type-checking (tsc) still runs and must pass; only ESLint is
  // skipped during `next build` so deploys aren't blocked on legacy lint.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
