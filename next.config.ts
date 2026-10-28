import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// Builds are a static export (served by nginx in Docker, by the CDN on Vercel). Static export can't
// use rewrites, so the /api proxy to a local ethan API (API_URL) exists only for `next dev`.
// Keyed on the Next phase, not NODE_ENV, so a stray NODE_ENV can't skip the export.
export default function config(phase: string): NextConfig {
  return phase === PHASE_DEVELOPMENT_SERVER
    ? { rewrites: async () => [{ source: "/api/:path*", destination: `${process.env.API_URL ?? "http://localhost:8000"}/api/:path*` }] }
    : { output: "export" };
}
