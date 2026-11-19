import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'three',
              test: /[\\/]node_modules[\\/]three[\\/]/,
            },
            {
              name: 'rapier',
              test: /[\\/]node_modules[\\/]@dimforge[\\/]rapier3d-compat[\\/]/,
            },
          ],
        },
      },
    },
  },
});
