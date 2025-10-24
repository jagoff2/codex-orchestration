/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#1d4ed8',
        accent: '#facc15',
        surface: '#0f172a',
      },
    },
  },
  plugins: [],
};
