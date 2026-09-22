import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'logo.svg', 'pwa-192x192.svg', 'pwa-512x512.svg', 'maskable-icon-512x512.svg'],
      manifest: {
        name: '阅读',
        short_name: '阅读',
        description: 'Legado 现代化 Web 阅读器与服务端',
        theme_color: '#247a58',
        background_color: '#f8f9f7',
        display: 'standalone',
        orientation: 'any',
        scope: '/',
        start_url: '/',
        // Windows 安装出来的 .ico 是从 PNG 图标生成的；只给 SVG 会被光栅化成糊成一团的小图，
        // 所以 PNG 必须排在前面并同时给出 192/512 与 maskable。
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/pwa-192x192.svg',
            sizes: '192x192',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/maskable-icon-512x512.svg',
            sizes: '512x512',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: '我的书架',
            short_name: '书架',
            url: '/',
            icons: [{ src: '/favicon-48.png', sizes: '48x48', type: 'image/png' }],
          },
          {
            name: '书源管理',
            short_name: '书源',
            url: '/#sources',
            icons: [{ src: '/favicon-48.png', sizes: '48x48', type: 'image/png' }],
          },
          {
            name: '替换净化',
            short_name: '净化',
            url: '/#replace-rules',
            icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2,ttf}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/tts\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^\/api\/search\/stream/,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^\/api\/book\/cover/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'legado-covers',
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
            },
          },
          {
            urlPattern: /^\/api\/(shelf|book\/toc)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'legado-meta-api',
              networkTimeoutSeconds: 3,
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60,
              },
            },
          },
        ],
      },
    }),
  ],
  server: { proxy: { '/api': 'http://localhost:8080' } },
})

