/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: '#060709',
          900: '#0a0c10',
          850: '#101218',
          800: '#161922',
          700: '#222634',
        },
        cinema: {
          gold: '#f59e0b',
          amber: '#fbbf24',
          accent: '#e50914',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['Outfit', 'Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'tv-focus': '0 0 0 3px rgba(255, 255, 255, 0.9), 0 10px 30px -5px rgba(0, 0, 0, 0.8), 0 0 25px rgba(255, 255, 255, 0.2)',
        'card-glow': '0 10px 30px -10px rgba(0, 0, 0, 0.7)',
        'hero-ambient': '0 -30px 100px 20px rgba(0, 0, 0, 0.95)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'scale-in': 'scaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'pulse-subtle': 'pulseSubtle 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        }
      }
    },
  },
  plugins: [],
}

