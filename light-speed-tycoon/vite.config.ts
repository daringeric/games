import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works when served from a subpath (e.g. GitHub Pages).
  base: './',
  server: { port: 5173 },
  preview: { port: 4173, strictPort: true },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
