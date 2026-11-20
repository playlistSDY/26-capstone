import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const previewHost = process.env.SWITCH_PREVIEW_HOST;

export default defineConfig({
  plugins: [react()],
  base: process.env.SWITCH_PREVIEW_BASE ?? "/",
  server: previewHost
    ? {
        allowedHosts: [previewHost],
        hmr: { host: previewHost, protocol: "wss", clientPort: 443 },
      }
    : {
        proxy: {
          "/agent-api": {
            target: "http://127.0.0.1:18732",
            changeOrigin: true,
          },
          "/api": { target: "http://127.0.0.1:18731", changeOrigin: true },
        },
      },
});
