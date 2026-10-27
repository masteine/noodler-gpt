import { defineConfig } from 'vitest/config'

// Окремий конфіг для тестів: без плагінів svelte/alphaTab, лише чиста логіка у Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
