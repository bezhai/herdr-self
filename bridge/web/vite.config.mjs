import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

// Two pages (the console and the /connect redirect). The server's CSP only allows same-origin
// scripts, styles and images, so nothing is inlined into HTML or turned into data: URIs.
export default defineConfig({
  root,
  // Keep Vite/Vitest caches in the package's node_modules rather than web/node_modules.
  cacheDir: fileURLToPath(new URL('../node_modules/.vite', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { index: `${root}index.html`, connect: `${root}connect.html` },
      // Name the chunks both pages share by content instead of after an arbitrary shared module.
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules/, priority: 2 },
            { name: 'shared', minShareCount: 2, priority: 1 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['src/test/setup.js'],
  },
});
