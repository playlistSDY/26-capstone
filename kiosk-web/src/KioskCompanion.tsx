import { uiText } from "./i18n";
import {
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  notice,
  conversation,
  guidance,
  screen,
  embedded = false,
}: {
  kiosk: HTMLElement;
  state: AttendantState;
  level: number;
  caption: string;
  notice?: string;
  conversation: {
    role: "assistant" | "user";
    text: string;
    id?: string;
    status?: "streaming" | "complete" | "interrupted";
  }[];
  guidance: GuidanceState | null;
  screen: string;
  embedded?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  const latestGuidance = useRef(guidance);
  latestGuidance.current = guidance;
  const [position, setPosition] = useState({ x: 20, y: 700 });
  const [scale, setScale] = useState(1);
  const [dialogueWidth, setDialogueWidth] = useState(640);
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
  const isHome = screen === "home";
  const isFixed = isHome || embedded;
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
  useLayoutEffect(() => {
    const update = () => {
      if (document.hidden || !root.current) return;
      const bounds = kiosk.getBoundingClientRect();
      const factor = bounds.width / kiosk.offsetWidth;
      if (!factor) return;
      kiosk.style.setProperty("--kiosk-display-scale", String(factor));
      if (embedded) {
        kiosk.style.setProperty("--agent-dialogue-space", "0px");
        return;
      }
      setScale(factor);
      setDialogueWidth(Math.min(640, Math.max(0, kiosk.offsetWidth - 40)));
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
      const dialogue = kiosk.querySelector<HTMLElement>(
        isHome ? ".welcome-companion-space" : ".agent-dialogue-space",
      );
      const sceneReady = (screen !== "menu" && !isHome) || !!dialogue;
      const context = `${screen}:${sceneReady}:${modal?.getAttribute("aria-label") ?? ""}:${kiosk.querySelector(".option-intro h2")?.textContent ?? ""}`;
      // The footer follows real menu/cart layout changes, never new text bubbles.
      const dialogueTop =
        isHome || (screen === "menu" && !inModal)
          ? (dialogue?.offsetTop ?? 0)
          : 0;
      const key = `${context}:${Math.round(bounds.width)}:${Math.round(size.current.width)}:${Math.round(size.current.height)}:${dialogueTop}:${dialogue?.offsetHeight ?? 0}`;
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
      const nook = dialogue && (isHome || !inModal) ? local(dialogue) : null;
      const inNook =
        nook && nook.y >= 72 && nook.y < stage.height
          ? clampPosition(
              {
                x: (stage.width - size.current.width) / 2,
                y:
                  isHome
                    ? nook.y + (nook.height - size.current.height) / 2
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
  }, [kiosk, screen, isHome, collapsed, embedded]);
  const feedback = uiText(companionFeedback(state, elapsed));
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
    // Use the native 800px kiosk coordinate system for all companion content.
    // The kiosk transform scales the avatar and bubbles together with the menu.
    "--companion-scale": 1,
    width:
      collapsed && !isHome
        ? `min(${dialogueWidth}px, var(--companion-character-width))`
        : `${dialogueWidth}px`,
    height: isHome ? undefined : "250px",
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
  const lastUser = useRef<number>(-1);
  useLayoutEffect(() => {
    const userIndex = conversation.reduce(
      (last, message, index) => (message.role === "user" ? index : last),
      -1,
    );
    if (lastUser.current !== userIndex || inputPending) follow.current = true;
    lastUser.current = userIndex;
    if (thread.current && (follow.current || inputPending))
      thread.current.scrollTop = thread.current.scrollHeight;
  }, [conversation, inputPending, waitingCaption, collapsed]);
  const character = <AgentAvatar state={state} level={level} />;
  return (
    <section
      ref={root}
      className={`kiosk-companion ${collapsed ? "is-collapsed" : ""}`}
      aria-label="키오스크 점원"
      data-screen={screen}
      data-x={Math.round(position.x)}
      data-y={Math.round(position.y)}
      data-waiting={isWaiting}
      style={embedded ? undefined : style}
    >
      {isFixed ? (
        <div className="companion-character">{character}</div>
      ) : (
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
          {character}
        </button>
      )}
      {(isFixed || !collapsed) && (
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
            const isGreeting = isHome && message.id === "greeting";
            const Text = isGreeting ? "h1" : "p";
            return (
              <div
                key={
                  message.id ??
                  `${conversation.length - recent.length + index}:${message.role}`
                }
                className={
                  message.role === "user"
                    ? "companion-user-bubble"
                    : `companion-speech${isGreeting ? " is-greeting" : ""}`
                }
                aria-label={
                  message.role === "user" &&
                  index === latestUser &&
                  !inputPending
                    ? "내가 한 말"
                    : undefined
                }
              >
                <Text
                  className={`companion-text${active ? " companion-caption" : ""}`}
                  aria-label={active && !isGreeting ? "현재 응답 자막" : undefined}
                >
                  {message.text}
                </Text>
                {message.status === "interrupted" && (
                  <small className="companion-interrupted">
                    말씀 도중 멈췄어요
                  </small>
                )}
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
                {receiving ? uiText("듣고 있어요") : feedback}
              </p>
              <span className="companion-activity" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
          {notice && (
            <div className="companion-speech is-notice" role="status">
              <p className="companion-text">{notice}</p>
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
