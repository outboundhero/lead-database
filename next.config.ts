import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  // Note: Next 16 no longer runs ESLint during `next build`, so pre-existing
  // react-hooks lint debt from the fork doesn't block deploys. Type-checking
  // (tsc) still runs and must pass.
};

export default nextConfig;
