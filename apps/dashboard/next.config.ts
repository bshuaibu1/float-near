import type { NextConfig } from "next";

/**
 * `distDir` is overridable so a SECOND dev server can run against this same
 * checkout without corrupting the first one's build.
 *
 * MEASURED: running throwaway dev servers here (for browser verification)
 * while the long-lived one served :3000 left both writing to the same
 * `.next`. They overwrote each other's build manifests and the long-lived
 * server began returning a mix of 200 / 404 / 500 for routes whose source was
 * fine — the SAME route flipping status between consecutive requests, with a
 * bare 21-byte "Internal Server Error" body rather than Next's dev error page
 * with a stack. Recovery needed `.next` deleted, not just a restart.
 *
 * Give a scratch server its own directory:
 *     NEXT_DIST_DIR=.next-preview next dev
 */
const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
};

export default nextConfig;
