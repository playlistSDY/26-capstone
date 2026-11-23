import { defineConfig } from "@playwright/test";
const port = Number(process.env.SWITCH_TEST_PORT || 5173);
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1360, height: 1040 },
    trace: "retain-on-failure",
    launchOptions: { args: ["--mute-audio"] },
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
  },
  projects: [
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
  ],
});
