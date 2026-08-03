import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  root: 'ui',
  plugins: [preact()],
  publicDir: false,
  build: {
    outDir: '../dist/ui',
    emptyOutDir: false,
    sourcemap: true,
  },
})
