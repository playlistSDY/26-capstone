import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const previewHost = process.env.SWITCH_PREVIEW_HOST;
const base = process.env.SWITCH_PREVIEW_BASE ?? "/";
const agentTarget =
  process.env.SWITCH_AGENT_TARGET ??
  "https://temp.sdy.world/980d563c-35d0-4ee2-9de0-161a08901e29";
const agentPrefix = `${base}agent-api`;

export default defineConfig({
  plugins: [react()],
  base,
  server: {
    ...(previewHost
      ? {
          allowedHosts: [previewHost],
          hmr: { host: previewHost, protocol: "wss" as const, clientPort: 443 },
        }
      : {}),
    proxy: {
      [agentPrefix]: {
        target: agentTarget,
        changeOrigin: true,
        rewrite: (requestPath) => requestPath.slice(base.length - 1),
        timeout: 120000,
        proxyTimeout: 120000,
      },
      ...(!previewHost
        ? { "/api": { target: "http://127.0.0.1:18731", changeOrigin: true } }
        : {}),
    },
  },
});
