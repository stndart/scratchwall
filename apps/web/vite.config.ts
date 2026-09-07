import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Scratchwall',
        short_name: 'Scratchwall',
        description: 'A fast, local-first wall of memos.',
        theme_color: '#101218',
        background_color: '#101218',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/auth\//,
          /^\/downloads\//,
          /^\/healthz$/,
          /^\/telegram\//
        ],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true
      }
    })
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/auth': 'http://127.0.0.1:8080',
      '/telegram': 'http://127.0.0.1:8080',
      '/downloads': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080'
    }
  },
  build: { target: 'es2022' }
});
