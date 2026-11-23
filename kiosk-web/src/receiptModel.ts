import { assetBase, findProduct } from "./catalog";
import {
  defaults,
  summary,
  unitPrice,
  paymentMethodName,
  type Order,
} from "./domain";

export const RECEIPT_PROFILE = {
  model: "EPSON TM-m30",
  connection: "USB",
  paperWidthMm: 80,
  printableWidthMm: 72,
  dots: 576,
  dpi: 203,
  sideMarginMm: 4,
} as const;
export type ReceiptVariant = "receipt" | "pickup";
export type ReceiptItem = {
  id: string;
  name: string;
  quantity: number;
  unitPrice: number | null;
  amount: number | null;
  optionsLabel: string;
};
export type ReceiptDocument = {
  id: string;
  number: string;
  createdAt: string;
  place: string;
  items: ReceiptItem[];
  quantity: number;
  total: number;
  method: string;
  legacy: boolean;
};
export function receiptDocument(order: Order): ReceiptDocument {
  return {
    id: order.id,
    number: order.number,
    createdAt: order.createdAt,
    place: order.place === "takeout" ? "포장" : "매장",
    items: order.lines.map((line) => {
      const product = findProduct(line.productId);
      const price =
        line.snapshot?.unitPrice ??
        (product ? unitPrice(product, line.options) : null);
      return {
        id: line.id,
        name: line.snapshot?.name ?? product?.name ?? "이전 메뉴",
        quantity: line.quantity,
        unitPrice: price,
        amount: price === null ? null : price * line.quantity,
        optionsLabel: line.snapshot?.optionsLabel ?? summary(line.options),
      };
    }),
    quantity: order.lines.reduce((count, line) => count + line.quantity, 0),
    total: order.total,
    method: paymentMethodName(order.method),
    legacy: order.lines.some((line) => !line.snapshot),
  };
}
export function receiptDate(date: string) {
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function sampleReceiptOrder(): Order {
  const americano = findProduct("americano")!,
    latte = findProduct("latte")!,
    vanilla = findProduct("vanilla")!;
  const lines = [
    {
      id: "sample-americano",
      product: americano,
      quantity: 2,
      options: { ...defaults(americano), temperature: "hot" as const },
    },
    {
      id: "sample-latte",
      product: latte,
      quantity: 1,
      options: {
        ...defaults(latte),
        temperature: "hot" as const,
        size: "large" as const,
        milk: "oat" as const,
        decaf: true,
        shots: 1,
      },
    },
    {
      id: "sample-vanilla",
      product: vanilla,
      quantity: 1,
      options: {
        ...defaults(vanilla),
        temperature: "ice" as const,
        sweetness: "less" as const,
      },
    },
  ].map(({ product, ...line }) => ({
    ...line,
    productId: product.id,
    snapshot: {
      name: product.name,
      unitPrice: unitPrice(product, line.options),
      optionsLabel: summary(line.options),
    },
  }));
  return {
    id: "sample-receipt-20261119",
    number: "024",
    createdAt: "2026-11-19T07:30:00.000Z",
    place: "takeout",
    method: "card",
    lines,
    total: lines.reduce(
      (sum, line) => sum + line.snapshot.unitPrice * line.quantity,
      0,
    ),
  };
}

export type PrintRequest = {
  id: string;
  orderId: string;
  variant: ReceiptVariant;
  createdAt: string;
  state:
    | "preparing"
    | "submitting"
    | "queued"
    | "file-saved"
    | "disabled"
    | "dialog-opened"
    | "dialog-closed"
    | "error";
  message?: string;
};
const jobKey = `switch.receipt.printRequests.${assetBase}`;
export function readPrintRequests(storage: Storage): PrintRequest[] {
  try {
    const data = JSON.parse(storage.getItem(jobKey) || "[]");
    return Array.isArray(data) ? data.slice(-50) : [];
  } catch {
    return [];
  }
}
export function savePrintRequest(storage: Storage, request: PrintRequest) {
  try {
    storage.setItem(
      jobKey,
      JSON.stringify(
        [
          ...readPrintRequests(storage).filter((j) => j.id !== request.id),
          request,
        ].slice(-50),
      ),
    );
  } catch {
    /* printing remains available if diagnostics storage is full */
  }
}
