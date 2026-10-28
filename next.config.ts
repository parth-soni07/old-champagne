import type { NextConfig } from "next";

// Builds are a static export (served by FastAPI in Docker, by the CDN on Vercel). Static export
// can't use rewrites, so the /api proxy to the local FastAPI server exists in dev only.
const nextConfig: NextConfig =
  process.env.NODE_ENV === "development"
    ? { rewrites: async () => [{ source: "/api/:path*", destination: "http://localhost:8000/api/:path*" }] }
    : { output: "export" };

export default nextConfig;
