import { svelte } from '@sveltejs/vite-plugin-svelte'
import { alphaTab } from '@coderline/alphatab-vite'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // VITE_API_PROXY (з .env або середовища) вмикає проксі /api на розгорнутий деплой у dev.
  const env = loadEnv(mode, process.cwd(), '')
  const apiProxy = env.VITE_API_PROXY

  return {
    // Шрифт і SoundFont підключаємо URL-імпортами в Player.svelte,
    // тому плагіну лишається лише зібрати воркери (копіювання ассетів вимкнено).
    plugins: [svelte(), alphaTab({ assetOutputDir: false })],
    server: apiProxy ? { proxy: { '/api': { target: apiProxy, changeOrigin: true } } } : {},
  }
})
