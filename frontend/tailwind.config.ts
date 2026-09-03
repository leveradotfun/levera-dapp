import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#131514",
        card: "#141414",
        elevated: "#1a1a1a",
        surface: "#1e1e1e",
        hover: "#222222",
        accent: "#ECE3D1",
        "accent-dim": "#C9BFAE",
        "accent-ink": "#0a0a0a",
        foreground: "#fafafa",
        secondary: "#a1a1aa",
        muted: "#71717a",
        border: "#252525",
        green: "#22c55e",
        red: "#ef4444",
        yellow: "#eab308",
        blue: {
          400: "#60a5fa",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
