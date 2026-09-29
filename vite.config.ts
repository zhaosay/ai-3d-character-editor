import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()] as never[],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three-core', test: /node_modules[\\/]three[\\/]/, priority: 30, maxSize: 500 * 1024 },
            { name: 'three-fiber', test: /node_modules[\\/]@react-three[\\/]/, priority: 20 },
            { name: 'react-core', test: /node_modules[\\/]react(?:-dom)?[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
})
