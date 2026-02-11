/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,jsx,ts,tsx,md,mdx}',
    './theme.config.tsx',
  ],
  theme: {
    extend: {
      colors: {
        'zk-bg': '#0B0F17',
        'zk-surface': '#111827',
        'zk-border': '#243041',
        'zk-teal': '#14B8A6',
        'zk-text': '#E5E7EB',
        'zk-text-muted': '#9CA3AF',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
    },
  },
  darkMode: 'class',
  plugins: [],
}
