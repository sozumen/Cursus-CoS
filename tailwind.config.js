/** Tailwind is compiled at build time (scripts/build.mjs), so the app works fully offline. */
module.exports = {
  content: ['./src/index.html', './src/js/**/*.js'],
  theme: {
    extend: {
      colors: { surface: 'var(--surface)', 'surface-2': 'var(--surface-2)', line: 'var(--line)', ink: 'var(--ink)', muted: 'var(--muted)', accent: 'var(--accent)' },
      fontFamily: { display: ['Bricolage Grotesque', 'system-ui', 'sans-serif'], mono: ['JetBrains Mono', 'ui-monospace', 'monospace'] }
    }
  }
};
