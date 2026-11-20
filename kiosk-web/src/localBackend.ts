import { assetUrl } from "./catalog";
export type PrinterSettings = {
  printerName: string;
  autoPrint: boolean;
  variant: "receipt" | "pickup";
  fontScale: number;
  offsetXmm: number;
  soundEnabled: boolean;
  soundVolume: number;
};
export type LocalPrinter = {
  name: string;
  driver: string;
  port: string;
  offline: boolean;
  virtual: boolean;
  status: number;
};
export const defaultPrinterSettings: PrinterSettings = {
  printerName: "",
  autoPrint: false,
  variant: "receipt",
  fontScale: 1,
  offsetXmm: 0,
  soundEnabled: true,
  soundVolume: 75,
};
export type BackendStatus = {
  app: string;
  token: string;
  platform: string;
  fileMode: boolean;
  settings: PrinterSettings;
};
let token = "";
export async function backendRequest<T>(
  route: string,
  value?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(assetUrl(`api/${route}`), {
      method: value === undefined ? "GET" : "POST",
      headers:
        value === undefined
          ? {}
          : { "Content-Type": "application/json", "X-Switch-Token": token },
      body: value === undefined ? undefined : JSON.stringify(value),
      signal: AbortSignal.timeout(route === "print" ? 60000 : 15000),
    });
  } catch {
    throw Error(
      "로컬 백엔드에 연결하지 못했어요. Windows 실행 배치파일을 확인해 주세요.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error(
      "로컬 실행 버전에서 사용할 수 있어요. Windows용 ZIP을 풀고 실행 배치파일을 열어 주세요.",
    );
  }
  if (!response.ok) throw Error(data.error || "로컬 요청을 처리하지 못했어요.");
  return data;
}
export async function loadBackend() {
  const status = await backendRequest<BackendStatus>("status");
  if (status.app !== "switch-kiosk-local-v1")
    throw Error("SWitch 백엔드가 아니에요.");
  token = status.token;
  return status;
}
export async function shutdownKiosk() {
  await loadBackend();
  const result = await backendRequest<{ stopping: boolean }>("shutdown", {});
  if (!result.stopping)
    throw Error("종료 요청을 확인하지 못했어요. 다시 시도해 주세요.");
}
export async function saveBackendSettings(value: PrinterSettings) {
  await loadBackend();
  const settings = (
    await backendRequest<{ settings: PrinterSettings }>("settings", value)
  ).settings;
  try {
    const channel = new BroadcastChannel("switch-device-settings");
    channel.postMessage(settings);
    channel.close();
  } catch {
    /* Same-page callback still updates settings. */
  }
  return settings;
}
