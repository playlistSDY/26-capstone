import { backendRequest, loadBackend } from "./localBackend";
import {
  savePrintRequest,
  type PrintRequest,
  type ReceiptDocument,
  type ReceiptVariant,
} from "./receiptModel";

export async function printReceipt(
  document: ReceiptDocument,
  variant: ReceiptVariant,
  onPhase: (request: PrintRequest) => void = () => {},
  kind: "auto" | "manual" | "test" = "manual",
) {
  let request: PrintRequest = {
    id: kind === "auto" ? "auto:" + document.id : crypto.randomUUID(),
    orderId: document.id,
    variant,
    createdAt: new Date().toISOString(),
    state: "preparing",
  };
  const emit = (patch: Partial<PrintRequest>) => {
    request = { ...request, ...patch };
    savePrintRequest(localStorage, request);
    onPhase(request);
  };
  emit({});
  try {
    const status = await loadBackend();
    if (kind === "auto" && !status.settings.autoPrint) {
      emit({ state: "disabled", variant: status.settings.variant });
      return { id: request.id, state: "disabled" as const };
    }
    const printVariant = kind === "auto" ? status.settings.variant : variant;
    emit({ state: "submitting", variant: printVariant });
    const job = await backendRequest<{
      id: string;
      state: string;
      message?: string;
    }>("print", {
      requestId: request.id,
      document,
      variant: printVariant,
      kind,
    });
    if (!["queued", "file-saved"].includes(job.state))
      throw Error(
        job.message ||
          "출력 상태를 확인하지 못했어요. Windows 인쇄 대기열을 확인해 주세요.",
      );
    emit({ state: job.state as "queued" | "file-saved" });
    return job;
  } catch (error) {
    emit({ state: "error", message: (error as Error).message });
    throw error;
  }
}
