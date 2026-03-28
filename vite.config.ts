import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    target: 'es2022',
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@sim': path.resolve(__dirname, 'src/simulation'),
      '@render': path.resolve(__dirname, 'src/rendering'),
      '@ui': path.resolve(__dirname, 'src/ui'),
      '@input': path.resolve(__dirname, 'src/input'),
      '@network': path.resolve(__dirname, 'src/network'),
    },
  },
});
