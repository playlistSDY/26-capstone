import { centerScroll } from "./centerScroll";
import { uiText } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./agent-guidance.css";

export type Guidance = {
  id: string;
  target: string;
  instruction: string;
  product_id?: string | null;
  line_id?: string | null;
  option?: string | null;
  value?: string | null;
};
export type GuidanceState = Guidance & { status: "showing" | "done" };

// Match registered semantic IDs, never selectors supplied by the model.
export function guidanceElement(guide: Guidance): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".kiosk [data-guide]"),
  ).find((node) => {
    if (
      node.dataset.guide !== guide.target ||
      !node.getClientRects().length ||
      node.closest("[hidden]")
    )
      return false;
    if (node instanceof HTMLButtonElement && node.disabled) return false;
    const modal = document.querySelector(".kiosk .overlay");
    if (modal && !modal.contains(node)) return false;
    if (guide.product_id && node.dataset.guideProduct !== guide.product_id)
      return false;
    if (
      guide.target.startsWith("cart.") &&
      guide.line_id &&
      node.dataset.guideLine !== guide.line_id
    )
      return false;
    if (guide.option && node.dataset.guideOption !== guide.option) return false;
    return guide.value != null
      ? node.dataset.guideValue === guide.value
      : node.dataset.guideValue === undefined;
  });
}

export function AgentGuidance({
  guide,
  onDone,
  onDismiss,
}: {
  guide: GuidanceState | null;
  onDone: () => void;
  onDismiss: () => void;
}) {
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const callbacks = useRef({ onDone, onDismiss });
  callbacks.current = { onDone, onDismiss };
  useEffect(() => {
    setRect(null);
    if (!guide || guide.status !== "showing") return;
    let node: HTMLElement | undefined;
    let scrolled = false;
    let restoreScroll: (() => void) | undefined;
    const update = () => {
      node = guidanceElement(guide);
      if (!node) {
        setRect(null);
        return;
      }
      if (!scrolled) {
        restoreScroll = centerScroll(node);
        scrolled = true;
      }
      const bounds = node.getBoundingClientRect();
      const next = {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      setRect((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const click = (event: MouseEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".kiosk button")
      )
        return;
      if (node?.contains(event.target)) callbacks.current.onDone();
      else callbacks.current.onDismiss();
    };
    update();
    // Covers scaled kiosk surfaces, nested scrolling, responsive changes and editor rendering.
    const timer = window.setInterval(update, 250);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    document.addEventListener("click", click, true);
    return () => {
      restoreScroll?.();
      clearInterval(timer);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("click", click, true);
    };
  }, [guide?.id, guide?.status]);

  // Guidance lives on the real control. Do not add a persistent tutorial panel.
  return rect && guide?.status === "showing"
    ? createPortal(
        <div className="agent-guide-ring" style={rect} aria-hidden="true">
          <span>{uiText("여기예요")}</span>
        </div>,
        document.body,
      )
    : null;
}
