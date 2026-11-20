import { useEffect, useRef } from "react";
import type { Order } from "./domain";
import { receiptDocument, type PrintRequest } from "./receiptModel";
import { printReceipt } from "./printReceipt";
import type { PrinterSettings } from "./localBackend";

export function AutoReceiptPrinter({
  order,
  settings,
  onPhase,
}: {
  order: Order;
  settings: PrinterSettings;
  onPhase: (state: PrintRequest["state"], message?: string) => void;
}) {
  const attempted = useRef<string | null>(null),
    phase = useRef(onPhase),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  phase.current = onPhase;
  useEffect(() => {
    if (attempted.current === order.id) return;
    attempted.current = order.id;
    void printReceipt(
      receiptDocument(order),
      settings.variant,
      (job) => {
        if (mounted.current) phase.current(job.state, job.message);
      },
      "auto",
    ).catch(() => {});
  }, [order, settings]);
  return null;
}
