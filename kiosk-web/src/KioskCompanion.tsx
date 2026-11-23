import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import { attendantLabels, type AttendantState } from "./attendantState";
import { guidanceElement, type GuidanceState } from "./AgentGuidance";
import "./kiosk-companion.css";

type Rect = { x: number; y: number; width: number; height: number };
export function overlaps(a: Rect, b: Rect, gap = 8) {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

export function KioskCompanion({
  kiosk,
  state,
  level,
  caption,
  heard,
  guidance,
  screen,
  historyOpen,
  onHistory,
}: {
  kiosk: HTMLElement;
  state: AttendantState;
  level: number;
  caption: string;
  heard: string;
  guidance: GuidanceState | null;
  screen: string;
  historyOpen: boolean;
  onHistory: () => void;
}) {
  const [position, setPosition] = useState({ x: 120, y: 1110 });
  useEffect(() => {
    const update = () => {
      const bounds = kiosk.getBoundingClientRect();
      const scale = bounds.width / kiosk.offsetWidth;
      if (!scale) return;
      const local = (node: HTMLElement): Rect => {
        const rect = node.getBoundingClientRect();
        return {
          x: (rect.left - bounds.left) / scale,
          y: (rect.top - bounds.top) / scale,
          width: rect.width / scale,
          height: rect.height / scale,
        };
      };
      const width = 560,
        height = 170;
      const target =
        guidance?.status === "showing" ? guidanceElement(guidance) : undefined;
      const focus = target ? local(target) : null;
      const obstacles = Array.from(
        kiosk.querySelectorAll<HTMLElement>(
          "button, input, textarea, h1, h2, h3, p, strong, img, .payment-total, .toast",
        ),
      )
        .filter(
          (node) =>
            !node.closest(".kiosk-companion, .kiosk-conversation-history") &&
            !node.classList.contains("exit-hotspot") &&
            node.getClientRects().length,
        )
        .map(local)
        .filter(
          (rect) =>
            rect.width > 0 &&
            rect.height > 0 &&
            rect.y < kiosk.offsetHeight - 180 &&
            rect.y + rect.height > 0,
        );
      const clampX = (x: number) =>
        Math.max(20, Math.min(kiosk.offsetWidth - width - 20, x));
      const preferredX = clampX(
        focus
          ? focus.x + focus.width / 2 - width / 2
          : screen === "cart"
            ? 24
            : screen === "payment"
              ? 210
              : 120,
      );
      const candidates: Rect[] = [];
      if (focus) {
        candidates.push({
          x: preferredX,
          y: focus.y + focus.height + 20,
          width,
          height,
        });
        candidates.push({
          x: preferredX,
          y: focus.y - height - 20,
          width,
          height,
        });
      } else if (screen === "cart")
        candidates.push({ x: 24, y: 560, width, height });
      for (const y of [320, 480, 660, 840, 1000])
        if (focus) candidates.push({ x: preferredX, y, width, height });
      const safe = candidates.find(
        (candidate) =>
          candidate.y >= 80 &&
          candidate.y + height <= kiosk.offsetHeight - 180 &&
          !obstacles.some((rect) => overlaps(candidate, rect)),
      );
      const next = safe ?? { x: preferredX, y: kiosk.offsetHeight - 174 };
      setPosition((previous) =>
        Math.abs(previous.x - next.x) < 2 && Math.abs(previous.y - next.y) < 2
          ? previous
          : { x: next.x, y: next.y },
      );
    };
    update();
    const timer = setInterval(update, 300);
    window.addEventListener("resize", update);
    kiosk.addEventListener("scroll", update, true);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", update);
      kiosk.removeEventListener("scroll", update, true);
    };
  }, [kiosk, guidance?.id, guidance?.status, screen, historyOpen]);

  return (
    <section
      className="kiosk-companion"
      aria-label="키오스크 점원"
      data-screen={screen}
      data-x={Math.round(position.x)}
      data-y={Math.round(position.y)}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
    >
      <AgentAvatar state={state} level={level} />
      <div className="companion-speech">
        <div className="companion-status" role="status">
          <span className="companion-dot" />
          {attendantLabels[state]}
        </div>
        {heard && (
          <div className="companion-heard" aria-label="내가 한 말">
            <span>내 말</span>
            <p>{heard}</p>
          </div>
        )}
        <p className="companion-caption" aria-label="현재 응답 자막">
          {caption}
        </p>
        <button
          type="button"
          aria-expanded={historyOpen}
          aria-label={historyOpen ? "대화 내역 닫기" : "대화 내역 보기"}
          onClick={onHistory}
        >
          <MessageCircle size={17} /> 대화 내역
        </button>
      </div>
    </section>
  );
}
