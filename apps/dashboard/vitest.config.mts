import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * The dashboard's test config, which exists because of ONE file.
 *
 * Before the InfoDot test every test here was pure TypeScript under lib/, so
 * vitest ran on its defaults. A .tsx test needs two things those defaults do
 * not provide.
 *
 * JSX. Next sets `"jsx": "preserve"` in tsconfig, which is right for Next -
 * its own compiler does the transform - and leaves the bundler emitting JSX
 * that vite cannot then parse. Overridden HERE rather than in tsconfig.json
 * on purpose: `next build` appends to that file by itself, so it is not a
 * stable place to keep a decision, and changing `preserve` would be altering
 * how the app builds in order to suit a test.
 *
 * `oxc`, NOT `esbuild`. The first version set `esbuild: { jsx: "automatic" }`
 * and failed with the same parse error, while vite printed the reason in a
 * warning I had skimmed past: "Both esbuild and oxc options were set. oxc
 * options will be used and esbuild options will be ignored." Vite 8 uses oxc.
 * The esbuild key is still accepted and silently discarded, which is the
 * worst shape a config option can have.
 *
 * `.mts`, because vite loads a `.ts` config as CommonJS here and warned about
 * the ESM syntax in it.
 *
 * THE ENVIRONMENT IS DELIBERATELY NOT SET. happy-dom is opted into per-file
 * by a docblock in the one test that needs a DOM. Setting it globally would
 * move 135 pure tests into a simulated browser for no reason, and would let
 * a lib/ module start depending on `document` without anything noticing.
 */
export default defineConfig({
  oxc: { jsx: "automatic" },
  resolve: {
    // `@/` is Next's alias; the component under test imports @/lib/colors.
    alias: { "@": resolve(import.meta.dirname, ".") },
  },
});
