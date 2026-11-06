import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-geist-mono)", "monospace"],
      },
      /**
       * ONE VOCABULARY, SHARED WITH web/index.html.
       *
       * These are not new colours. The dashboard already used every one of
       * them — as inline hex, 395 times across 15 files — so this is a
       * naming change, not a redesign. `#787774` appeared 156 times,
       * `#111111` 127, `#EAEAEA` 80, `#A0A09A` 16.
       *
       * `chip` is the one value that was genuinely ambiguous: the dashboard
       * had three greys doing the same job (`#F7F6F3` ×16, `#F2F2F1` ×10,
       * `#F3F3F1` ×1). Settled on `#F3F3F1`, which is what the create page
       * uses — a user crossing between the two surfaces should not be able
       * to tell they changed products.
       *
       * The matching custom properties live in web/index.html's `:root`.
       * That page cannot import from here (standalone HTML, no build step),
       * so the two are copies — and copies drift. Treat a change to either
       * as a change to both.
       */
      colors: {
        canvas: "#FBFBFA", // page background
        card: "#FFFFFF", // raised surfaces: data modules, rows, panels
        ink: "#111111", // primary text, primary buttons
        muted: "#787774", // secondary text, labels
        faint: "#A0A09A", // tertiary text: hints, timestamps, empty states
        line: "#EAEAEA", // borders and dividers
        chip: "#F3F3F1", // badges, tags, node ids, inert pills

        /**
         * STATUS. The same values as lib/colors.ts, which is the source for
         * inline styles.
         *
         * Both exist because the call sites genuinely differ. Most status
         * colour in this dashboard is conditional - `pct >= 80 ? DANGER :
         * SUCCESS` - and lives in `style={{}}`, where a class cannot go
         * without restructuring the JSX. A handful are plain class names,
         * and those use these.
         *
         * THEY MUST AGREE. A divergence shows up as two slightly different
         * reds on one screen, which reads as a rendering bug rather than a
         * config one.
         */
        danger: "#9F2F2D",
        "danger-bg": "#FDEBEC",
        success: "#346538",
        "success-bg": "#EDF3EC",
        warn: "#92400E",
        "warn-bg": "#FEF6E7",
      },
    },
  },
  plugins: [],
};

export default config;
