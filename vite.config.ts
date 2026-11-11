import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const base = process.env.VITE_BASE_PATH || '/';
if (!base.startsWith('/') || !base.endsWith('/'))
  throw new Error('VITE_BASE_PATH must start and end with /.');
export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Card Cabinet',
        short_name: 'Cabinet',
        description: 'Offline card collection with local photos and optional metadata sync.',
        id: base,
        start_url: base,
        scope: base,
        display: 'standalone',
        background_color: '#f5f4ed',
        theme_color: '#203f34',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,png,svg,woff2}', 'third-party/*.txt'],
        maximumFileSizeToCacheInBytes: 4000000,
        navigateFallback: base + 'index.html',
        cleanupOutdatedCaches: true,
        skipWaiting: false,
        clientsClaim: true,
      },
    }),
  ],
  build: { target: 'es2022', chunkSizeWarningLimit: 1100 },
});
