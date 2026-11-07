import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages project site: https://<user>.github.io/chess_analyzer/
export default defineConfig({
  plugins: [react()],
  base: '/chess_analyzer/',
})
