import type { Server } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type ViteDevServer } from "vite"

const dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Node's http server gives every request 5 minutes, measured from its first
 * byte to its last — a wall clock, not an idle timeout. A video submission is
 * a single request that can legitimately run longer than that, and the dev
 * server proxying it is a plain Node server with the same default, so it would
 * answer 408 mid-upload no matter what the API allows. Matches the ceiling the
 * API sets on itself in apps/api/src/main.ts.
 */
const raiseUploadTimeout = {
  name: "raise-upload-timeout",
  configureServer(server: ViteDevServer) {
    // Absent in middleware mode, where the host app owns the server. Vite
    // types it widely enough to include an http2 server, which this never is.
    const httpServer = server.httpServer as Server | null
    if (httpServer) httpServer.requestTimeout = 30 * 60 * 1000
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), raiseUploadTimeout],
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
