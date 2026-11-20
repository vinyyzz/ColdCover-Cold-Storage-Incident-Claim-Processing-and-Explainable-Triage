import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingRoot: process.cwd(),
  outputFileTracingIncludes: { "/*": ["./drizzle/**/*"] },
  turbopack: {
    // This app has its own dependencies inside a separate parent repository.
    root: process.cwd(),
  },
};

export default nextConfig;
