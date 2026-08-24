import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// GitHub Pages serves this project under /usbip-browser/. Override with
// BASE_PATH=/ when serving from a domain root. actions/configure-pages emits
// a base_path without a trailing slash, which Vite needs, so normalise it.
const raw = process.env['BASE_PATH'] || '/usbip-browser/';
const base = raw.endsWith('/') ? raw : `${raw}/`;

export default defineConfig({
  base,
  resolve: {
    alias: {
      // Use the library sources directly so the example always reflects the
      // working tree, with no build step between edit and reload.
      'usbip-browser/cdc-acm': fileURLToPath(new URL('../../src/cdc-acm/index.ts', import.meta.url)),
      'usbip-browser/wisp': fileURLToPath(new URL('../../src/transport/wisp.ts', import.meta.url)),
      'usbip-browser/mock': fileURLToPath(new URL('../../src/mock/index.ts', import.meta.url)),
      'usbip-browser': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
