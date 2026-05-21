import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  // For GitHub Pages project sites, assets must use /<repo>/ as base.
  const base =
    mode === 'production'
      ? (process.env.GITHUB_PAGES_BASE || '/')
      : '/';

  return {
    base,
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
        },
      },
    },
  };
});
