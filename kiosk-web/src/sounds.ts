import { useEffect } from "react";
import { assetUrl } from "./catalog";
import type { PrinterSettings } from "./localBackend";

export const soundChoices = [
  { id: "tap", label: "기본 터치" },
  { id: "select", label: "메뉴·옵션 선택" },
  { id: "add", label: "메뉴 담기" },
  { id: "increase", label: "수량 증가" },
  { id: "decrease", label: "수량 감소" },
  { id: "back", label: "이전·취소" },
  { id: "remove", label: "메뉴 삭제" },
  { id: "scroll", label: "목록 스크롤" },
  { id: "read", label: "카드 인식" },
  { id: "success", label: "주문 완료" },
  { id: "error", label: "오류 안내" },
  { id: "print", label: "출력 알림" },
] as const;
export type Sound = (typeof soundChoices)[number]["id"];
type SoundSettings = Pick<PrinterSettings, "soundEnabled" | "soundVolume">;
let context: AudioContext | null = null;
let generation = 0;
const raw = new Map<Sound, Promise<ArrayBuffer>>();
const decoded = new Map<Sound, Promise<AudioBuffer>>();
const priority: Record<Sound, number> = {
  tap: 1,
  select: 1,
  add: 2,
  increase: 1,
  decrease: 1,
  back: 2,
  remove: 2,
  scroll: 0,
  read: 3,
  print: 3,
  success: 4,
  error: 4,
};
let active: {
  node: AudioBufferSourceNode;
  gain: GainNode;
  priority: number;
  end: number;
} | null = null;

function loadRaw(kind: Sound) {
  if (!raw.has(kind)) {
    const pending = fetch(assetUrl(`assets/sounds/v2/${kind}.wav`)).then(
      (response) => {
        if (!response.ok) throw Error("Sound asset unavailable");
        return response.arrayBuffer();
      },
    );
    raw.set(kind, pending);
    void pending.catch(() => raw.delete(kind));
  }
  return raw.get(kind)!;
}
function audioContext() {
  context ??= new AudioContext({ latencyHint: "interactive" });
  return context;
}
function loadBuffer(kind: Sound) {
  if (!decoded.has(kind)) {
    const pending = loadRaw(kind).then((bytes) =>
      audioContext().decodeAudioData(bytes.slice(0)),
    );
    decoded.set(kind, pending);
    void pending.catch(() => decoded.delete(kind));
  }
  return decoded.get(kind)!;
}
function fadeActive() {
  if (!active || !context) return;
  const previous = active;
  active = null;
  const now = context.currentTime;
  previous.gain.gain.cancelScheduledValues(now);
  previous.gain.gain.setValueAtTime(previous.gain.gain.value, now);
  previous.gain.gain.linearRampToValueAtTime(0, now + 0.008);
  try {
    previous.node.stop(now + 0.01);
  } catch {
    /* Already ended. */
  }
}
export function stopKioskSounds() {
  generation++;
  fadeActive();
}
export function playSound(
  kind: Sound,
  settings: SoundSettings,
  preview = false,
) {
  if (!settings.soundEnabled || settings.soundVolume <= 0) return;
  try {
    const ctx = audioContext(),
      version = generation,
      requested = performance.now();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    void loadBuffer(kind)
      .then((buffer) => {
        if (
          version !== generation ||
          (!preview && performance.now() - requested > 600)
        )
          return;
        if (
          !preview &&
          active &&
          active.end > ctx.currentTime &&
          active.priority >= 3 &&
          active.priority > priority[kind]
        )
          return;
        fadeActive();
        const node = ctx.createBufferSource(),
          gain = ctx.createGain();
        const start = ctx.currentTime + 0.012;
        node.buffer = buffer;
        gain.gain.value =
          (Math.max(0, Math.min(100, settings.soundVolume)) / 100) * 0.95;
        node.connect(gain);
        gain.connect(ctx.destination);
        const voice = {
          node,
          gain,
          priority: priority[kind],
          end: start + buffer.duration,
        };
        active = voice;
        node.onended = () => {
          if (active === voice) active = null;
          node.disconnect();
          gain.disconnect();
        };
        node.start(start);
      })
      .catch(() => {});
  } catch {
    /* Ordering still works when no audio device is available. */
  }
}

export function soundForControl(target: HTMLElement): Sound | null {
  if (
    target.hasAttribute("data-sound-preview") ||
    target.closest(".reader-device")
  )
    return null;
  if (target.matches("input[type=range]")) return null;
  const text = (
    target.getAttribute("aria-label") ||
    target.textContent ||
    ""
  ).trim();
  if (/늘리기/.test(text)) return "increase";
  if (/줄이기/.test(text)) return "decrease";
  if (/위로|아래로/.test(text)) return "scroll";
  if (/삭제/.test(text)) return "remove";
  if (/담기|수정하기/.test(text)) return "add";
  if (/취소|이전|닫기|처음|아니요/.test(text)) return "back";
  if (
    target.matches(".product-card,.choice,.payment-method,input,select") ||
    /확인|결제하기/.test(text)
  )
    return "select";
  return "tap";
}
export function useKioskSounds(settings: PrinterSettings) {
  useEffect(() => {
    for (const { id } of soundChoices) void loadRaw(id).catch(() => {});
  }, []);
  useEffect(() => {
    if (!settings.soundEnabled || settings.soundVolume <= 0) stopKioskSounds();
    let lastScroll = 0;
    const click = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(
              "button,input[type=checkbox],input[type=radio],select",
            )
          : null;
      if (!target || target.hasAttribute("disabled")) return;
      const kind = soundForControl(target);
      if (kind === "scroll") lastScroll = Date.now();
      if (kind) playSound(kind, settings);
    };
    const change = (event: Event) => {
      if (event.target instanceof HTMLSelectElement)
        playSound("select", settings);
    };
    const scroll = (event: Event) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.matches(
          ".catalog-scroll,.dock-lines,.cart-lines,.option-scroll",
        )
      )
        return;
      const now = Date.now();
      if (now - lastScroll > 500) {
        lastScroll = now;
        playSound("scroll", settings);
      }
    };
    document.addEventListener("click", click, true);
    document.addEventListener("change", change, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("click", click, true);
      document.removeEventListener("change", change, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [settings.soundEnabled, settings.soundVolume]);
}
