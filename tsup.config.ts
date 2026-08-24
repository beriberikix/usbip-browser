import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    wisp: 'src/transport/wisp.ts',
    'cdc-acm': 'src/cdc-acm/index.ts',
    mock: 'src/mock/index.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
});
