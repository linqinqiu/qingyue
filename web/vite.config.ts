import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * 图标资产版本号。这些 PNG/SVG 的文件名**不带 hash**，所以换了图形以后，
 * Service Worker 与 Chrome 仍会拿旧字节回答同一个 URL —— 桌面快捷方式就会一直
 * 显示上一版图形。改这一个常量等于给所有图标 URL 换指纹，客户端必然重取。
 * 每次动 `web/public` 下的图标就 +1。
 */
const ICON_VERSION = '2'
const icon = (src: string, sizes: string, type: string, purpose = 'any') => ({
  src: `${src}?v=${ICON_VERSION}`,
  sizes,
  type,
  purpose,
})

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 自建单机阅读器：客户端与服务端同机，不需要「发现新版本」再等用户点确认。
      // 之前用 'prompt'，一旦用户错过/没点更新提示，SW 会一直拿旧 precache 回答，
      // 表现就是「服务端改了、界面永远是旧的」。autoUpdate 让新 SW 自动 skipWaiting+claim，
      // 刷新即生效，从根上消掉这类「改了看不到」的假死。
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'pwa-192x192.svg', 'pwa-512x512.svg', 'maskable-icon-512x512.svg'],
      manifest: {
        name: '青阅',
        short_name: '青阅',
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
          icon('/pwa-192x192.png', '192x192', 'image/png'),
          icon('/pwa-512x512.png', '512x512', 'image/png'),
          icon('/maskable-icon-512x512.png', '512x512', 'image/png', 'maskable'),
          icon('/pwa-192x192.svg', '192x192', 'image/svg+xml'),
          icon('/pwa-512x512.svg', '512x512', 'image/svg+xml'),
          icon('/maskable-icon-512x512.svg', '512x512', 'image/svg+xml', 'maskable'),
        ],
        shortcuts: [
          {
            name: '我的书架',
            short_name: '书架',
            url: '/',
            icons: [{ src: `/favicon-48.png?v=${ICON_VERSION}`, sizes: '48x48', type: 'image/png' }],
          },
          {
            name: '书源管理',
            short_name: '书源',
            url: '/#sources',
            icons: [{ src: `/favicon-48.png?v=${ICON_VERSION}`, sizes: '48x48', type: 'image/png' }],
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
        // /next 是新骨架（另一份 index.html）。不放进黑名单的话，已经装了这份 SW 的浏览器
        // 会把对 /next/ 的导航用**旧界面**的 shell 回答 —— 看着就像"挂载没生效"。
        navigateFallbackDenylist: [/^\/api\//, /^\/next(\/|$)/],
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

