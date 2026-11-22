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
  disabled,
  onDone,
  onDismiss,
  onRequest,
  onShortcut,
  hasCart,
}: {
  guide: GuidanceState | null;
  disabled: boolean;
  onDone: () => void;
  onDismiss: () => void;
  onRequest: (text: string) => void;
  onShortcut: (target: string) => void;
  hasCart: boolean;
}) {
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [located, setLocated] = useState(false);
  const callbacks = useRef({ onDone, onDismiss });
  callbacks.current = { onDone, onDismiss };
  useEffect(() => {
    setRect(null);
    setLocated(false);
    if (!guide || guide.status !== "showing") return;
    let node: HTMLElement | undefined;
    let scrolled = false;
    const update = () => {
      node = guidanceElement(guide);
      if (!node) {
        setRect(null);
        setLocated(false);
        return;
      }
      if (!scrolled) {
        node.scrollIntoView({
          behavior: "instant",
          block: "nearest",
          inline: "nearest",
        });
        scrolled = true;
      }
      const bounds = node.getBoundingClientRect();
      const next = {
        left: bounds.left,
        top: bounds.top,
        width: bounds.width,
        height: bounds.height,
      };
      setLocated(true);
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
      clearInterval(timer);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      document.removeEventListener("click", click, true);
    };
  }, [guide?.id, guide?.status]);

  return (
    <section className="agent-guidance" aria-label="화면 사용 안내">
      <div
        className="agent-guidance-message"
        id="agent-guidance-message"
        role="status"
      >
        <strong>
          {guide
            ? guide.status === "done"
              ? "선택한 내용을 반영했어요"
              : "화면에서 함께 확인해요"
            : "직접 눌러도, 말로 주문해도 돼요"}
        </strong>
        <p>
          {guide
            ? guide.status === "done"
              ? "이어서 직접 고르시거나, 다음 안내를 받아보세요."
              : guide.instruction
            : "설명하는 메뉴와 옵션을 화면에서 표시해 드려요."}
        </p>
        {guide?.status === "showing" && !located && (
          <small>
            현재 화면에서 표시할 위치를 찾고 있어요. 원하는 작업을 말로
            부탁하셔도 돼요.
          </small>
        )}
      </div>
      {hasCart && (
        <div className="agent-guide-shortcuts" aria-label="주문 버튼 위치 안내">
          <button
            disabled={disabled}
            onClick={() => onShortcut("cart.quantity")}
          >
            수량 버튼 위치
          </button>
          <button
            disabled={disabled}
            onClick={() => onShortcut("cart.options")}
          >
            옵션 버튼 위치
          </button>
          <button disabled={disabled} onClick={() => onShortcut("checkout")}>
            결제 버튼 위치
          </button>
        </div>
      )}
      <div className="agent-guide-actions">
        <button
          disabled={disabled}
          onClick={() =>
            onRequest(
              guide
                ? "현재 화면에서 다음 단계의 버튼을 표시하고 짧게 설명해 주세요. 주문은 제가 직접 눌러볼게요."
                : "키오스크 사용법을 알려주세요. 현재 화면에서 다음에 누를 버튼 하나를 표시하며 설명해 주세요.",
            )
          }
        >
          {guide ? "다음 단계 알려줘" : "사용법 알려줘"}
        </button>
        {guide && (
          <button
            disabled={disabled}
            onClick={() =>
              onRequest(
                `방금 설명한 작업을 대신 해주세요. 안내: ${guide.instruction}`,
              )
            }
          >
            대신 해줘
          </button>
        )}
        {guide && (
          <button className="agent-guide-dismiss" onClick={onDismiss}>
            표시 닫기
          </button>
        )}
      </div>
      {rect &&
        guide?.status === "showing" &&
        createPortal(
          <div className="agent-guide-ring" style={rect} aria-hidden="true">
            <span>여기예요</span>
          </div>,
          document.body,
        )}
    </section>
  );
}
