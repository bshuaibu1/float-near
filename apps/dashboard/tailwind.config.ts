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
      colors: {
        canvas: "#FBFBFA",
        ink:    "#111111",
        muted:  "#787774",
        line:   "#EAEAEA",
      },
    },
  },
  plugins: [],
};

export default config;
