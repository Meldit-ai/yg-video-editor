import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  server: {
    port: 8701,
    // The API pins its CORS origin to this exact port, so fail loudly rather
    // than silently drifting to the next free one.
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8700",
        changeOrigin: true,
      },
    },
  },
})
