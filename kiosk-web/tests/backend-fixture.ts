import type { Page } from "@playwright/test";
export async function mockBackend(
  page: Page,
  initial: Record<string, unknown> = {},
) {
  let settings = {
    printerName: "EPSON TM-m30",
    autoPrint: false,
    variant: "receipt",
    fontScale: 1,
    offsetXmm: 0,
    soundEnabled: true,
    soundVolume: 45,
    ...initial,
  };
  const jobs: Array<Record<string, unknown>> = [];
  let shutdownRequests = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/status"))
      body = {
        app: "switch-kiosk-local-v1",
        token: "test-token",
        platform: "win32",
        fileMode: false,
        settings,
      };
    else if (path.endsWith("/shutdown")) {
      shutdownRequests++;
      body = { stopping: true };
    } else if (path.endsWith("/printers"))
      body = {
        printers: [
          {
            name: "EPSON TM-m30",
            driver: "Epson APD",
            port: "USB001",
            offline: false,
            virtual: false,
            status: 0,
          },
        ],
      };
    else if (path.endsWith("/settings")) {
      settings = { ...settings, ...request.postDataJSON() };
      body = { settings };
    } else if (path.endsWith("/jobs")) body = { jobs };
    else if (path.endsWith("/print")) {
      const payload = request.postDataJSON();
      let job = jobs.find((j) => j.id === payload.requestId);
      if (!job) {
        job = {
          id: payload.requestId,
          state: "queued",
          number: payload.document.number,
          ...payload,
        };
        jobs.push(job!);
      }
      body = job;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  return {
    jobs,
    get shutdownRequests() {
      return shutdownRequests;
    },
    get settings() {
      return settings;
    },
  };
}
