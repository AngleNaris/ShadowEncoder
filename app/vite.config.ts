import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 的 dev server 固定端口，与 tauri.conf.json 的 devUrl 对应
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
