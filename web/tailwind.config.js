/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // zeroK color scheme
        'zk-bg': '#0B0F17',           // Main background
        'zk-surface': '#111827',       // Card/panel surfaces
        'zk-surface-light': '#1F2937', // Elevated surfaces
        'zk-border': '#243041',        // Borders
        'zk-teal': '#14B8A6',          // Primary accent (teal-500)
        'zk-teal-light': '#2DD4BF',    // Hover state (teal-400)
        'zk-teal-dark': '#0D9488',     // Active state (teal-600)
        'zk-text': '#E5E7EB',          // Primary text
        'zk-text-muted': '#9CA3AF',    // Secondary text
        'zk-success': '#22C55E',       // Success (green-500)
        'zk-warning': '#F59E0B',       // Warning (amber-500)
        'zk-danger': '#EF4444',        // Error (red-500)
        'zk-info': '#3B82F6',          // Info (blue-500)
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'glass': 'linear-gradient(135deg, rgba(17, 24, 39, 0.9) 0%, rgba(17, 24, 39, 0.7) 100%)',
      },
      backdropBlur: {
        'glass': '20px',
      },
      animation: {
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
        'shield-pulse': 'shield-pulse 1.5s ease-in-out infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': {
            boxShadow: '0 0 20px rgba(20, 184, 166, 0.4)',
          },
          '50%': {
            boxShadow: '0 0 40px rgba(20, 184, 166, 0.8)',
          },
        },
        'shield-pulse': {
          '0%, 100%': {
            transform: 'scale(1)',
            opacity: '1',
          },
          '50%': {
            transform: 'scale(1.05)',
            opacity: '0.8',
          },
        },
      },
    },
  },
  plugins: [],
};
