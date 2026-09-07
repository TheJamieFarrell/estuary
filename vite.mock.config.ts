/**
 * Plain-browser Vite config for the renderer.
 *
 * Electron is not involved, so `window.api` is undefined and `src/renderer/lib/api.ts`
 * falls back to the seeded in-memory mock in `src/renderer/lib/mock.ts`. Used for UI work
 * and for capturing the screenshots in `docs/assets/`.
 *
 *   npx vite --config vite.mock.config.ts --port 5179
 *   http://localhost:5179/index.html     main window
 *   http://localhost:5179/compose.html   compose window
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * The renderer HTML carries a strict Content-Security-Policy meta tag for the packaged app.
 * `script-src 'self'` rejects the inline react-refresh preamble that @vitejs/plugin-react
 * injects in dev, so strip the meta tag for this browser-only config.
 */
const stripCsp = {
  name: 'strip-csp-meta',
  transformIndexHtml(html: string) {
    return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '')
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [stripCsp, react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  server: { port: 5179, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'out/mock'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        compose: resolve(__dirname, 'src/renderer/compose.html')
      }
    }
  }
})
