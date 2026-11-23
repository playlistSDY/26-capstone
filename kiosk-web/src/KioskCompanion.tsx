import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AgentAvatar } from "./AgentAvatar";
import type { AttendantState } from "./attendantState";
import { guidanceElement, type GuidanceState } from "./AgentGuidance";
import { companionFeedback, waitingState } from "./companionFeedback";
import {
  companionPosition,
  clampPosition,
  type Rect,
} from "./companionPlacement";
import "./kiosk-companion.css";

export function KioskCompanion({
  kiosk,
  state,
  level,
  caption,
  conversation,
  guidance,
  screen,
}: {
  kiosk: HTMLElement;
  state: AttendantState;
  level: number;
  caption: string;
  conversation: { role: "assistant" | "user"; text: string }[];
  guidance: GuidanceState | null;
  screen: string;
}) {
  const root = useRef<HTMLElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const latestGuidance = useRef(guidance);
  latestGuidance.current = guidance;
  const [position, setPosition] = useState({ x: 20, y: 700 });
  const [scale, setScale] = useState(1);
  const [physicalWidth, setPhysicalWidth] = useState(640);
  const anchored = useRef("");
  const [collapsed, setCollapsed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const manual = useRef(false);
  const dragged = useRef(false);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const current = useRef(position);
  current.current = position;
  const size = useRef({ width: 540, height: 250 });
  const isWaiting = waitingState(state);
  useEffect(() => {
    setElapsed(0);
    if (!isWaiting) return;
    const start = performance.now();
    const timer = setInterval(
      () => setElapsed(performance.now() - start),
      1000,
    );
    return () => clearInterval(timer);
  }, [state, isWaiting]);
  useEffect(() => {
    const update = () => {
      if (document.hidden || !root.current) return;
      const bounds = kiosk.getBoundingClientRect();
      const factor = bounds.width / kiosk.offsetWidth;
      if (!factor) return;
      setScale(factor);
      setPhysicalWidth(Math.min(640, Math.max(240, bounds.width - 20)));
      kiosk.style.setProperty("--kiosk-display-scale", String(factor));
      const local = (node: HTMLElement): Rect => {
        const r = node.getBoundingClientRect();
        return {
          x: (r.left - bounds.left) / factor,
          y: (r.top - bounds.top) / factor,
          width: r.width / factor,
          height: r.height / factor,
        };
      };
      size.current = {
        width: root.current.offsetWidth,
        height: root.current.offsetHeight,
      };
      const stage = { width: kiosk.offsetWidth, height: kiosk.offsetHeight };
      const inModal = !!kiosk.querySelector(".overlay");
      kiosk.style.setProperty(
        "--agent-dialogue-space",
        screen === "menu" && !inModal ? `${size.current.height + 12}px` : "0px",
      );
      const modal = kiosk.querySelector<HTMLElement>(".overlay .modal");
      const sceneReady =
        screen === "menu"
          ? !!kiosk.querySelector(".agent-dialogue-space")
          : screen === "home"
            ? !!kiosk.querySelector(".welcome-drinks")
            : true;
      const context = `${screen}:${sceneReady}:${modal?.getAttribute("aria-label") ?? ""}:${kiosk.querySelector(".option-intro h2")?.textContent ?? ""}`;
      // The footer follows real menu/cart layout changes, never new text bubbles.
      const dialogueTop =
        screen === "menu" && !inModal
          ? (kiosk.querySelector<HTMLElement>(".agent-dialogue-space")
              ?.offsetTop ?? 0)
          : 0;
      const key = `${context}:${Math.round(bounds.width)}:${Math.round(size.current.width)}:${Math.round(size.current.height)}:${Math.round(dialogueTop)}`;
      if (anchored.current === key) return;
      if (!anchored.current.startsWith(context + ":")) manual.current = false;
      anchored.current = key;
      if (manual.current) {
        const clamped = clampPosition(current.current, size.current, stage);
        setPosition((old) =>
          old.x === clamped.x && old.y === clamped.y ? old : clamped,
        );
        return;
      }
      const currentGuide = latestGuidance.current;
      const target =
        currentGuide?.status === "showing"
          ? guidanceElement(currentGuide)
          : undefined;
      const obstacles = Array.from(
        kiosk.querySelectorAll<HTMLElement>(
          "button, input, textarea, h1, h2, h3, img, .payment-total, .option-footer, .cart-bar, .cart-checkout, .toast",
        ),
      )
        .filter(
          (node) =>
            !node.closest(".kiosk-companion, .kiosk-conversation-history") &&
            !node.classList.contains("exit-hotspot") &&
            node.getClientRects().length &&
            getComputedStyle(node).visibility !== "hidden",
        )
        .map(local)
        .filter(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            r.y < stage.height &&
            r.y + r.height > 0,
        );
      const dialogue = !inModal
        ? kiosk.querySelector<HTMLElement>(
            screen === "home" ? ".welcome-drinks" : ".agent-dialogue-space",
          )
        : null;
      const nook = dialogue ? local(dialogue) : null;
      const inNook =
        nook && nook.y >= 72 && nook.y < stage.height
          ? clampPosition(
              {
                x: (stage.width - size.current.width) / 2,
                y:
                  screen === "home"
                    ? nook.y + nook.height - size.current.height - 16
                    : nook.y + 12,
              },
              size.current,
              stage,
            )
          : null;
      const next = inNook
        ? inNook
        : companionPosition(
            stage,
            size.current,
            obstacles,
            target ? local(target) : null,
            screen,
          );
      setPosition((previous) =>
        Math.abs(previous.x - next.x) < 2 && Math.abs(previous.y - next.y) < 2
          ? previous
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    const timer = setInterval(update, 400);
    window.addEventListener("resize", update);
    kiosk.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      clearInterval(timer);
      window.removeEventListener("resize", update);
      kiosk.removeEventListener("scroll", update, true);
    };
  }, [kiosk, screen, collapsed]);
  const feedback = companionFeedback(state, elapsed);
  const receiving = state === "typing" || state === "hearing";
  const waitingCaption = receiving
    ? "듣고 있어요"
    : isWaiting &&
        (caption === "요청을 확인하고 있어요." ||
          state === "offline" ||
          state === "transcribing")
      ? feedback
      : caption;
  const moveTo = (x: number, y: number) => {
    manual.current = true;
    setPosition(
      clampPosition({ x, y }, size.current, {
        width: kiosk.offsetWidth,
        height: kiosk.offsetHeight,
      }),
    );
  };
  const style = {
    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
    "--companion-scale": scale,
    width: `${(collapsed ? Math.min(physicalWidth, 180) : physicalWidth) / scale}px`,
    height: `${250 / scale}px`,
  } as CSSProperties;
  const inputPending = receiving || state === "transcribing";
  const showWait =
    !inputPending &&
    isWaiting &&
    (conversation.at(-1)?.role !== "assistant" || state === "offline");
  const recent = conversation.slice(-6);
  const latestUser = recent.reduce(
    (found, message, index) => (message.role === "user" ? index : found),
    -1,
  );
  useEffect(() => {
    if (thread.current && (follow.current || inputPending))
      thread.current.scrollTop = thread.current.scrollHeight;
  }, [conversation, inputPending, waitingCaption, collapsed]);
  return (
    <section
      ref={root}
      className={`kiosk-companion ${collapsed ? "is-collapsed" : ""}`}
      aria-label="키오스크 점원"
      data-screen={screen}
      data-x={Math.round(position.x)}
      data-y={Math.round(position.y)}
      data-waiting={isWaiting}
      style={style}
    >
      <button
        className="companion-character"
        aria-label={
          collapsed ? "점원 말풍선 펼치기" : "점원 옮기기 또는 말풍선 접기"
        }
        aria-expanded={!collapsed}
        onPointerDown={(e) => {
          dragged.current = false;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: position.x,
            top: position.y,
          };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = (e.clientX - drag.current.x) / scale,
            dy = (e.clientY - drag.current.y) / scale;
          if (Math.abs(dx) + Math.abs(dy) > 8 / scale) {
            dragged.current = true;
            moveTo(drag.current.left + dx, drag.current.top + dy);
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClick={(event) => {
          if (event.detail === 0 || !dragged.current) setCollapsed((v) => !v);
        }}
        onKeyDown={(e) => {
          const keys: Record<string, [number, number]> = {
            ArrowLeft: [-24, 0],
            ArrowRight: [24, 0],
            ArrowUp: [0, -24],
            ArrowDown: [0, 24],
          };
          const delta = keys[e.key];
          if (delta) {
            e.preventDefault();
            moveTo(
              position.x + delta[0] / scale,
              position.y + delta[1] / scale,
            );
          }
        }}
      >
        <AgentAvatar state={state} level={level} />
      </button>
      {!collapsed && (
        <div
          ref={thread}
          className="companion-bubbles"
          aria-label="점원과 손님의 대화"
          onScroll={() => {
            if (thread.current)
              follow.current =
                thread.current.scrollHeight -
                  thread.current.scrollTop -
                  thread.current.clientHeight <
                24;
          }}
        >
          {recent.map((message, index) => {
            const active =
              !inputPending && !showWait && index === recent.length - 1;
            return (
              <div
                key={`${conversation.length - recent.length + index}:${message.role}`}
                className={
                  message.role === "user"
                    ? "companion-user-bubble"
                    : "companion-speech"
                }
                aria-label={
                  message.role === "user" &&
                  index === latestUser &&
                  !inputPending
                    ? "내가 한 말"
                    : undefined
                }
              >
                <p
                  className={`companion-text${active ? " companion-caption" : ""}`}
                  aria-label={active ? "현재 응답 자막" : undefined}
                >
                  {active && message.role === "assistant"
                    ? caption
                    : message.text}
                </p>
              </div>
            );
          })}
          {inputPending && (
            <div
              className="companion-user-bubble is-pending"
              aria-label="손님 발화 인식 중"
            >
              <p
                className="companion-text companion-caption"
                aria-label="현재 응답 자막"
              >
                {receiving ? "듣고 있어요" : feedback}
              </p>
              <span className="companion-activity" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
          {showWait && (
            <div className="companion-speech is-pending">
              <p
                className="companion-text companion-caption"
                aria-label="현재 응답 자막"
              >
                {waitingCaption}
              </p>
              <span className="companion-activity" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
