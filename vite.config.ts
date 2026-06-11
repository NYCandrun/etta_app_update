import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Vite config tuned for Tauri: fixed dev port, no clearScreen so Rust errors stay visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  // Tauri uses a fixed target; produce a single chunked build under dist/.
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
  },
});
