import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueJsx(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@lichtblick/suite': fileURLToPath(new URL('./src/suite', import.meta.url)),
      '@lichtblick/suite-base': fileURLToPath(new URL('./src/suite-base', import.meta.url)),
      '@lichtblick/mcap-support': fileURLToPath(new URL('./src/mcap-support', import.meta.url)),
    },
  },
})
