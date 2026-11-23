import { LanguageSelector } from "./LanguageSelector";
import { useLocale } from "./i18n";
import { uiText } from "./i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Coffee,
  CreditCard,
  Expand,
  Home,
  Minus,
  Plus,
  ReceiptText,
  Printer,
  Settings2,
  RotateCcw,
  ShoppingBag,
  ShoppingBasket,
  Store,
  X,
  CircleHelp,
  Clock3,
  CheckCircle2,
  TriangleAlert,
  Power,
} from "lucide-react";
import {
  categories,
  assetUrl,
  findProduct,
  money,
  products,
  type Category,
  type Product,
  type Temperature,
  productImage,
  temperatureBadge,
} from "./catalog";
import {
  completeOrder,
  MAX_ORDER_QUANTITY,
  defaults,
  putLine,
  readDraft,
  readOrders,
  summary,
  totalPrice,
  unitPrice,
  writeDraft,
  type CartLine,
  type Options,
  type Order,
  type PaymentMethod,
  type Place,
} from "./domain";
import { ReceiptPreview } from "./ReceiptPreview";
import { sampleReceiptOrder } from "./receiptModel";
import type { PrintRequest } from "./receiptModel";
import { AutoReceiptPrinter } from "./AutoReceiptPrinter";
import { PrinterSettingsPanel } from "./PrinterSettingsPanel";
import {
  defaultPrinterSettings,
  loadBackend,
  shutdownKiosk,
} from "./localBackend";
import { playSound, useKioskSounds } from "./sounds";
import { PaymentPanelBody, paymentMethods, type Payment } from "./PaymentFlow";
import { paymentMethodName } from "./domain";

type Screen = "home" | "menu" | "cart" | "payment" | "finalizing" | "completed";
type Outcome = "success" | "failure" | "timeout";
type Editor = {
  product: Product;
  options: Options;
  quantity: number;
  lineId?: string;
  error: string;
};
type Overlay =
  | "cancel"
  | "clear"
  | "place"
  | "help"
  | "idle"
  | "receipt"
  | "history"
  | "printer"
  | "shutdown"
  | null;
const placeName = (p: Place) => (p === "store" ? "매장" : "포장");
const methodName = paymentMethodName;

function Brand({ large = false }: { large?: boolean }) {
  return (
    <div className={`brand ${large ? "brand-large" : ""}`} aria-label="SWitch">
      <span className="brand-mark">
        <span className="brand-native">
          <i />
          <i />
          <i />
          <img
            src={assetUrl(
              "assets/figma/ddbba01e5e1c9d78f46ad7d1bcfc3fd35c10231d.svg",
            )}
            alt=""
          />
        </span>
      </span>
      <b>SWitch</b>
    </div>
  );
}
function ProductImage({
  product,
  className = "",
  temperature,
}: {
  product: Product;
  className?: string;
  temperature?: Temperature | null;
}) {
  return (
    <img
      className={className}
      src={productImage(product, temperature)}
      alt={uiText(product.name)}
      data-temperature={temperature ?? product.temperatures[0]}
      draggable={false}
      decoding="async"
    />
  );
}
function Counter({
  value,
  onChange,
  max = MAX_ORDER_QUANTITY,
  min = 1,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  label: string;
}) {
  return (
    <div className="counter">
      <button
        aria-label={uiText(`${label} 줄이기`)}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus size={19} />
      </button>
      <strong aria-label={uiText(label)}>{uiText(value)}</strong>
      <button
        aria-label={uiText(`${label} 늘리기`)}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus size={19} />
      </button>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  className = "",
  dismissOnBackdrop = true,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
  dismissOnBackdrop?: boolean;
  closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onClick={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={uiText(title)}
        className={`modal ${className}`}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !closeDisabled) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const targets = Array.from(
              ref.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled),a,input,select,[tabindex="0"]',
              ),
            );
            const first = targets[0],
              last = targets.at(-1);
            if (!first) {
              e.preventDefault();
              return;
            }
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === ref.current)
            ) {
              e.preventDefault();
              last?.focus();
            }
            if (
              !e.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === ref.current)
            ) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="modal-top">
          <span>{uiText(title)}</span>
          <button
            className="icon-button"
            aria-label={uiText("닫기")}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {uiText(children)}
      </div>
    </div>
  );
}

function PaymentPanel({
  payment,
  total,
  onStart,
  onCancel,
  onRetry,
}: {
  payment: Payment;
  total: number;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  return (
    <Modal
      title={uiText(methodName(payment.method))}
      dismissOnBackdrop={false}
      onClose={onCancel}
      closeDisabled={payment.status === "approved"}
      className="payment-modal"
    >
      <PaymentPanelBody
        payment={payment}
        total={total}
        onStart={onStart}
        onCancel={onCancel}
        onRetry={onRetry}
      />
    </Modal>
  );
}

export default function App() {
  useLocale();
  const [initial] = useState(() => readDraft(localStorage));
  const [screen, setScreen] = useState<Screen>(initial ? "menu" : "home");
  const [place, setPlace] = useState<Place>(initial?.place ?? "store");
  const [cart, setCart] = useState<CartLine[]>(initial?.lines ?? []);
  const [category, setCategory] = useState<Category>("추천 메뉴");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(() =>
    new URLSearchParams(location.search).get("printerSetup") === "1"
      ? "printer"
      : null,
  );
  const [toast, setToast] = useState(
    initial ? "이전에 담은 주문을 불러왔어요." : "",
  );
  const [outcome, setOutcome] = useState<Outcome>("success");
  const [payment, setPayment] = useState<Payment | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null);
  const [receiptSample, setReceiptSample] = useState(false);
  const [printerSettings, setPrinterSettings] = useState(
    defaultPrinterSettings,
  );
  useKioskSounds(printerSettings);
  useEffect(() => {
    const refresh = () => {
      void loadBackend()
        .then((s) => setPrinterSettings(s.settings))
        .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    const channel = new BroadcastChannel("switch-device-settings");
    channel.onmessage = (event) => setPrinterSettings(event.data);
    return () => {
      window.removeEventListener("focus", refresh);
      channel.close();
    };
  }, []);
  useEffect(() => {
    if (screen === "completed")
      playSound(
        autoPrint?.state === "error" ? "error" : "success",
        printerSettings,
      );
  }, [screen]);
  useEffect(() => {
    if (payment?.status === "failure" || payment?.status === "timeout")
      playSound("error", printerSettings);
    else if (payment?.status === "reading") playSound("read", printerSettings);
  }, [payment?.status]);
  const [autoPrint, setAutoPrint] = useState<{
    state: PrintRequest["state"];
    message?: string;
  } | null>(null);
  useEffect(() => {
    const openSettings = (event: KeyboardEvent) => {
      if (exitRequested.current) return;
      if (event.ctrlKey && event.altKey && event.code === "KeyS") {
        event.preventDefault();
        setOverlay("printer");
      } else if (event.ctrlKey && event.altKey && event.code === "KeyH") {
        event.preventDefault();
        setHistory(readOrders(localStorage));
        setOverlay("history");
      }
    };
    window.addEventListener("keydown", openSettings);
    return () => window.removeEventListener("keydown", openSettings);
  }, []);
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState(1);
  const [idleSeconds, setIdleSeconds] = useState(20);
  const [finishSeconds, setFinishSeconds] = useState(5);
  const [storageError, setStorageError] = useState(false);
  const [history, setHistory] = useState<Order[]>([]);
  const [helpRequested, setHelpRequested] = useState(false);
  const [exitPending, setExitPending] = useState(false);
  const [exitError, setExitError] = useState("");
  const exitRequested = useRef(false);
  const exitTaps = useRef({ count: 0, started: 0 });
  useEffect(() => {
    exitTaps.current = { count: 0, started: 0 };
    const resetTaps = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".exit-hotspot")
      )
        exitTaps.current = { count: 0, started: 0 };
    };
    window.addEventListener("pointerdown", resetTaps);
    return () => window.removeEventListener("pointerdown", resetTaps);
  }, [screen, overlay]);
  const surface = useRef<HTMLDivElement>(null);
  const catalogScroll = useRef<HTMLDivElement>(null);
  const dockScroll = useRef<HTMLDivElement>(null);
  const [dockPosition, setDockPosition] = useState({ up: false, down: false });
  const reviewScroll = useRef<HTMLDivElement>(null);
  const [reviewPosition, setReviewPosition] = useState({
    up: false,
    down: false,
  });
  const previousDockLength = useRef(0);
  const processing = useRef(false);
  const lastActivity = useRef(Date.now());
  const standalone = new URLSearchParams(location.search).get("kiosk") === "1";
  const total = totalPrice(cart),
    count = cart.reduce((n, l) => n + l.quantity, 0);
  const receipt = receiptOrder ?? order;

  useEffect(() => {
    const element = surface.current!;
    const observer = new ResizeObserver(([entry]) =>
      setScale(
        Math.min(
          entry.contentRect.width / 800,
          entry.contentRect.height / 1280,
        ),
      ),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setStorageError(!writeDraft(localStorage, place, cart));
  }, [place, cart]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    catalogScroll.current?.scrollTo({ top: 0 });
  }, [category, screen]);
  useEffect(() => {
    const el = dockScroll.current;
    if (!el) return;
    const update = () =>
      setDockPosition({
        up: el.scrollTop > 1,
        down: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      });
    if (cart.length > previousDockLength.current)
      el.scrollTo({ top: el.scrollHeight });
    previousDockLength.current = cart.length;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [cart, screen]);
  useEffect(() => {
    const el = reviewScroll.current;
    if (!el) return;
    const update = () =>
      setReviewPosition({
        up: el.scrollTop > 1,
        down: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [cart, screen]);
  useEffect(() => {
    if (!payment || ["failure", "timeout"].includes(payment.status)) return;
    const attempt = payment;
    const delay =
      payment.status === "waiting"
        ? outcome === "timeout"
          ? 45000
          : 3000
        : payment.status === "reading"
          ? 1600
          : payment.status === "processing"
            ? 1800
            : 1000;
    const timer = setTimeout(() => {
      if (attempt.status === "waiting") {
        if (outcome === "timeout")
          setPayment({ ...attempt, status: "timeout" });
        else {
          processing.current = true;
          setPayment({ ...attempt, status: "reading" });
        }
        return;
      }
      if (attempt.status === "reading") {
        setPayment({ ...attempt, status: "processing" });
        return;
      }
      if (attempt.status === "processing") {
        if (outcome !== "success") {
          processing.current = false;
          setPayment({ ...attempt, status: outcome });
        } else setPayment({ ...attempt, status: "approved" });
        return;
      }
      try {
        const completed = completeOrder(localStorage, {
          id: attempt.attempt,
          place,
          lines: cart,
          method: attempt.method,
        });
        setOrder(completed);
        setCart([]);
        setScreen("finalizing");
        setPayment(null);
        setFinishSeconds(5);
        setAutoPrint(null);
      } catch {
        setToast(
          "주문을 저장하지 못했어요. 브라우저 저장 공간을 확인하고 다시 시도해 주세요.",
        );
        setPayment({ ...attempt, status: "failure" });
      }
      processing.current = false;
    }, delay);
    return () => clearTimeout(timer);
  }, [payment, outcome, cart, place]);
  useEffect(() => {
    if (screen !== "finalizing" || !order || !autoPrint) return;
    // queued is acknowledged only after the native worker's Print() returns.
    // File mode and disabled printing also finish, while errors remain visible.
    if (["queued", "file-saved", "disabled", "error"].includes(autoPrint.state))
      setScreen("completed");
  }, [screen, order?.id, autoPrint?.state]);
  useEffect(() => {
    if (screen !== "completed" || overlay) return;
    const timer = setInterval(() => setFinishSeconds((n) => n - 1), 1000);
    return () => clearInterval(timer);
  }, [screen, overlay]);
  useEffect(() => {
    if (screen === "completed" && finishSeconds <= 0) reset();
  }, [finishSeconds, screen]);
  useEffect(() => {
    const record = () => {
      lastActivity.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    events.forEach((name) =>
      window.addEventListener(name, record, { passive: true }),
    );
    const timer = setInterval(() => {
      if (
        screen === "home" ||
        screen === "completed" ||
        screen === "finalizing" ||
        screen === "payment" ||
        overlay
      )
        return;
      if (Date.now() - lastActivity.current > 120000) {
        setOverlay("idle");
        setIdleSeconds(20);
      }
    }, 1000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, record));
      clearInterval(timer);
    };
  }, [screen, overlay]);
  useEffect(() => {
    if (overlay !== "idle") return;
    const timer = setInterval(() => setIdleSeconds((n) => n - 1), 1000);
    return () => clearInterval(timer);
  }, [overlay]);
  useEffect(() => {
    if (overlay === "idle" && idleSeconds <= 0) reset();
  }, [idleSeconds, overlay]);

  function reset() {
    setCart([]);
    setScreen("home");
    setEditor(null);
    setOverlay(null);
    setPayment(null);
    setOrder(null);
    setAutoPrint(null);
    setCategory("추천 메뉴");
    setHelpRequested(false);
    processing.current = false;
    lastActivity.current = Date.now();
  }
  function start(p: Place) {
    setPlace(p);
    setScreen("menu");
    lastActivity.current = Date.now();
  }
  function configure(product: Product, line?: CartLine) {
    setEditor({
      product,
      quantity: line?.quantity ?? 1,
      options: line?.options ?? defaults(product, category === "디카페인"),
      lineId: line?.id,
      error: "",
    });
  }
  function editOption<K extends keyof Options>(key: K, value: Options[K]) {
    setEditor((e) =>
      e ? { ...e, options: { ...e.options, [key]: value }, error: "" } : null,
    );
  }
  function add() {
    if (!editor) return;
    try {
      setCart(
        putLine(
          cart,
          {
            id: editor.lineId ?? crypto.randomUUID(),
            productId: editor.product.id,
            options: editor.options,
            quantity: editor.quantity,
          },
          editor.lineId,
        ),
      );
      setToast(
        editor.lineId
          ? "주문 내용을 수정했어요."
          : `${editor.product.name} 담았어요.`,
      );
      setEditor(null);
    } catch (e) {
      setEditor({ ...editor, error: (e as Error).message });
    }
  }
  function changeQuantity(line: CartLine, n: number) {
    try {
      setCart(putLine(cart, { ...line, quantity: n }, line.id));
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  function beginPayment() {
    if (
      !payment ||
      payment.status !== "waiting" ||
      processing.current ||
      outcome === "timeout"
    )
      return;
    processing.current = true;
    setPayment({ ...payment, status: "reading" });
  }
  function cancelPayment() {
    if (payment?.status === "approved") return;
    processing.current = false;
    setPayment(null);
    lastActivity.current = Date.now();
  }
  function showHistory() {
    setReceiptSample(false);
    setReceiptOrder(null);
    setHistory(readOrders(localStorage).reverse());
    setOverlay("history");
  }
  function closeOverlay() {
    if (exitRequested.current) return;
    setOverlay(null);
    lastActivity.current = Date.now();
  }
  function tapExitCorner() {
    if (screen !== "home" || overlay) return;
    const now = Date.now();
    const taps = exitTaps.current;
    if (!taps.count || now - taps.started > 5000) {
      taps.count = 0;
      taps.started = now;
    }
    taps.count += 1;
    if (taps.count === 5) {
      exitTaps.current = { count: 0, started: 0 };
      setExitError("");
      setOverlay("shutdown");
    }
  }
  async function confirmExit() {
    if (exitRequested.current) return;
    exitRequested.current = true;
    setExitPending(true);
    setExitError("");
    try {
      await shutdownKiosk();
    } catch (error) {
      exitRequested.current = false;
      setExitPending(false);
      setExitError(
        error instanceof Error
          ? error.message
          : "종료 요청에 실패했어요. 다시 시도해 주세요.",
      );
    }
  }
  const optionButtons = <K extends keyof Options>(
    key: K,
    items: { value: Options[K]; label: string; extra?: string }[],
  ) => (
    <div className="choice-row">
      {uiText(
        items.map((item) => (
          <button
            key={String(item.value)}
            className={`choice ${editor?.options[key] === item.value ? "selected" : ""}`}
            aria-pressed={editor?.options[key] === item.value}
            onClick={() => editOption(key, item.value)}
          >
            <span>{uiText(item.label)}</span>
            {uiText(item.extra && <small>{uiText(item.extra)}</small>)}
            {uiText(editor?.options[key] === item.value && <Check size={19} />)}
          </button>
        )),
      )}
    </div>
  );
  return (
    <div className={`studio ${standalone ? "standalone" : ""}`}>
      {uiText(
        !standalone && (
          <div className="studio-bar">
            <div className="studio-title">
              <span className="live-dot" />
              SWitch <span>{uiText("키오스크 미리보기")}</span>
            </div>
            <div className="studio-actions">
              <label>
                {uiText("결제 테스트")}
                {uiText(" ")}
                <select
                  aria-label={uiText("결제 테스트 결과")}
                  value={outcome}
                  disabled={
                    !!payment &&
                    ["reading", "processing", "approved"].includes(
                      payment.status,
                    )
                  }
                  onChange={(e) => setOutcome(e.target.value as Outcome)}
                >
                  <option value="success">{uiText("승인 성공")}</option>
                  <option value="failure">{uiText("승인 실패")}</option>
                  <option value="timeout">{uiText("응답 없음")}</option>
                </select>
              </label>
              <button
                onClick={() => {
                  setReceiptOrder(sampleReceiptOrder());
                  setReceiptSample(true);
                  setOverlay("receipt");
                }}
              >
                <Printer size={15} />
                {uiText("영수증 시안")}
              </button>
              <button onClick={showHistory}>
                <ReceiptText size={15} />
                {uiText("주문 이력")}
              </button>
              <button onClick={() => setOverlay("printer")}>
                <Settings2 size={15} />
                {uiText("프린터 설정")}
              </button>
              <button onClick={() => setFit(!fit)}>
                {uiText(fit ? "실제 크기" : "화면 맞춤")}
              </button>
              <button
                aria-label={uiText("전체화면")}
                onClick={() => {
                  if (document.fullscreenElement)
                    document.exitFullscreen().catch(() => {});
                  else
                    surface.current
                      ?.requestFullscreen()
                      .catch(() =>
                        setToast("브라우저에서 전체화면을 지원하지 않아요."),
                      );
                }}
              >
                <Expand size={17} />
              </button>
            </div>
          </div>
        ),
      )}
      <div
        className={`preview-surface ${fit ? "fit" : "actual"}`}
        ref={surface}
      >
        <div
          className="kiosk-space"
          style={{
            width: 800 * (fit ? scale : 1),
            height: 1280 * (fit ? scale : 1),
          }}
        >
          <main
            className="kiosk"
            style={{ transform: `scale(${fit ? scale : 1})` }}
            aria-label={uiText("SWitch 주문 키오스크")}
          >
            {uiText(
              screen === "home" ? (
                <section className="home-screen">
                  <button
                    className="exit-hotspot"
                    aria-label={uiText("키오스크 종료 메뉴")}
                    onClick={tapExitCorner}
                  />
                  <header className="welcome-header">
                    <Brand large />
                    <span>{uiText("SWitch 커피")}</span>
                    <LanguageSelector />
                  </header>
                  <div className="welcome-copy">
                    <span className="eyebrow">
                      {uiText("반가워요, 오늘도 SWitch")}
                    </span>
                    <h1>
                      {uiText("오늘은 어디서")}
                      <br />
                      {uiText("즐기실 건가요?")}
                    </h1>
                    <p>{uiText("취향에 맞는 한 잔을 준비해 드릴게요.")}</p>
                  </div>
                  <div className="welcome-drinks" aria-hidden="true">
                    <ProductImage product={products[0]} />
                    <ProductImage product={products[1]} />
                    <ProductImage product={products[2]} />
                  </div>
                  <div className="place-cards">
                    <button onClick={() => start("store")}>
                      <span className="place-icon">
                        <Store size={47} strokeWidth={1.6} />
                      </span>
                      <strong>{uiText("먹고 갈게요")}</strong>
                      <span>
                        {uiText("매장에서 편안하게")}
                        <ArrowRight size={21} />
                      </span>
                    </button>
                    <button onClick={() => start("takeout")}>
                      <span className="place-icon">
                        <ShoppingBag size={47} strokeWidth={1.6} />
                      </span>
                      <strong>{uiText("포장할게요")}</strong>
                      <span>
                        {uiText("어디서나 가볍게")}
                        <ArrowRight size={21} />
                      </span>
                    </button>
                  </div>
                  <div className="home-bottom">
                    <span>{uiText("좋은 하루의 시작, 좋은 커피 한 잔.")}</span>
                    <button onClick={() => setOverlay("help")}>
                      <CircleHelp size={18} />
                      {uiText("도움이 필요해요")}
                    </button>
                  </div>
                </section>
              ) : screen === "finalizing" && order ? (
                <section className="order-finalizing-screen" aria-busy="true">
                  <header className="completion-header">
                    <Brand />
                    <span>
                      <CheckCircle2 size={17} />
                      {uiText(" 결제 완료")}
                    </span>
                  </header>
                  <div
                    className="order-finalizing-content"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="finalizing-orbit" aria-hidden="true">
                      <span />
                      <ShoppingBag size={44} strokeWidth={1.5} />
                    </div>
                    <h1>{uiText("주문을 완료하고 있어요")}</h1>
                    <p>{uiText("잠시만 기다려 주세요.")}</p>
                    <div className="finalizing-dots" aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </section>
              ) : screen === "completed" && order ? (
                <section className="completed-screen">
                  <header className="completion-header">
                    <Brand />
                    <span>
                      <CheckCircle2 size={17} />
                      {uiText(" 결제 완료")}
                    </span>
                  </header>
                  <div className="completion-heading">
                    <span className="completion-mark">
                      <Check size={29} strokeWidth={2.6} />
                    </span>
                    <h1>{uiText("주문이 완료됐어요")}</h1>
                    <p>{uiText("주문번호를 확인해 주세요.")}</p>
                  </div>
                  <div className="order-number pickup-ticket">
                    <div className="ticket-heading">
                      <span>{uiText("나의 주문번호")}</span>
                      <span className="ticket-place">
                        {uiText(
                          order.place === "takeout" ? (
                            <ShoppingBag size={18} />
                          ) : (
                            <Store size={18} />
                          ),
                        )}
                        {uiText(placeName(order.place))}
                      </span>
                    </div>
                    <strong>{uiText(order.number)}</strong>
                    <p>
                      {uiText(order.number)}
                      {uiText("번으로 알려드릴게요.")}
                    </p>
                    <div className="ticket-perforation" aria-hidden="true" />
                    <div className="ticket-summary">
                      <span>
                        {uiText(
                          order.lines.reduce((n, l) => n + l.quantity, 0),
                        )}
                        {uiText("개 ·")}
                        {uiText(" ")}
                        {uiText(methodName(order.method))}
                      </span>
                      <b>{uiText(money(order.total))}</b>
                    </div>
                  </div>
                  <div
                    className={`receipt-output-card ${autoPrint && ["submitting", "queued", "file-saved"].includes(autoPrint.state) ? "is-printing" : "is-preparing"}`}
                  >
                    <div className="receipt-status-icon" aria-hidden="true">
                      <Printer size={32} strokeWidth={1.6} />
                    </div>
                    <div className="receipt-output-copy">
                      <div
                        className="completion-receipt-message"
                        role="status"
                        aria-live="polite"
                      >
                        {uiText(
                          autoPrint?.state === "error"
                            ? "영수증 출력 확인이 필요해요."
                            : autoPrint?.state === "disabled"
                              ? "주문번호로 받아 주세요."
                              : autoPrint &&
                                  [
                                    "submitting",
                                    "queued",
                                    "file-saved",
                                  ].includes(autoPrint.state)
                                ? "영수증 출력중이에요."
                                : "영수증 출력 준비중이에요.",
                        )}
                      </div>
                      <p>
                        {uiText(
                          autoPrint?.state === "error"
                            ? "직원에게 주문번호를 보여 주세요."
                            : autoPrint?.state === "disabled"
                              ? "영수증이 필요하면 직원에게 말씀해 주세요."
                              : "아래에서 영수증을 받아 주세요.",
                        )}
                      </p>
                    </div>
                    <ChevronDown
                      size={23}
                      className="receipt-output-arrow"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="completion-farewell">
                    <Coffee size={25} strokeWidth={1.6} />
                    <p>{uiText("맛있게 드세요!")}</p>
                  </div>
                  <footer className="completion-footer">
                    <button className="primary full" onClick={reset}>
                      {uiText("처음으로 돌아가기")}
                      <ArrowRight size={22} />
                    </button>
                    <div className="completion-countdown">
                      <span className="countdown-track" aria-hidden="true">
                        <i
                          style={{
                            width: `${Math.max(0, finishSeconds) * 20}%`,
                          }}
                        />
                      </span>
                      <small>
                        {uiText(finishSeconds)}
                        {uiText("초 후 처음 화면으로 돌아가요.")}
                      </small>
                    </div>
                  </footer>
                </section>
              ) : (
                <>
                  <header className="kiosk-header">
                    <LanguageSelector />
                    {uiText(
                      screen !== "cart" ? (
                        <button
                          className="icon-button"
                          aria-label={uiText(
                            screen === "menu" ? "처음으로" : "이전 화면",
                          )}
                          onClick={() => {
                            if (screen === "menu") {
                              if (cart.length) setOverlay("cancel");
                              else reset();
                            } else {
                              setScreen(screen === "payment" ? "cart" : "menu");
                              cancelPayment();
                            }
                          }}
                        >
                          {uiText(
                            screen === "menu" ? (
                              <Home size={23} />
                            ) : (
                              <ArrowLeft size={25} />
                            ),
                          )}
                          {uiText(" ")}
                        </button>
                      ) : (
                        <span className="header-back-spacer" />
                      ),
                    )}
                    <Brand />
                    <button
                      className="place-switch"
                      onClick={() => {
                        if (payment?.status === "processing") return;
                        setOverlay("place");
                      }}
                    >
                      {uiText(placeName(place))}
                      <ChevronDown size={15} />
                    </button>
                  </header>
                  {uiText(
                    screen === "menu" ? (
                      <>
                        <nav
                          className="categories"
                          aria-label={uiText("메뉴 카테고리")}
                        >
                          {uiText(
                            categories.map((cat) => (
                              <button
                                key={cat}
                                className={category === cat ? "active" : ""}
                                aria-current={
                                  category === cat ? "page" : undefined
                                }
                                onClick={() => setCategory(cat)}
                              >
                                {uiText(cat)}
                              </button>
                            )),
                          )}
                        </nav>
                        <div className="catalog-scroll" ref={catalogScroll}>
                          <div className="product-grid">
                            {uiText(
                              products
                                .filter((p) => p.categories.includes(category))
                                .map((product) => (
                                  <button
                                    key={product.id}
                                    className={`product-card ${product.soldOut ? "sold-out" : ""}`}
                                    disabled={product.soldOut}
                                    aria-label={uiText(
                                      `${product.name} ${money(product.price + (category === "디카페인" && !product.decafOnly ? 500 : 0))}${product.soldOut ? " 품절" : ""}`,
                                    )}
                                    onClick={() => configure(product)}
                                  >
                                    <div className="product-picture">
                                      <ProductImage product={product} />
                                      <span
                                        className={`temperature-badge ${product.temperatures.length === 1 ? product.temperatures[0] : "both"}`}
                                      >
                                        {uiText(temperatureBadge(product))}
                                      </span>
                                      {uiText(
                                        product.soldOut && (
                                          <span className="sold-out-label">
                                            {uiText("품절")}
                                          </span>
                                        ),
                                      )}
                                    </div>
                                    <strong>{uiText(product.name)}</strong>
                                    <span>
                                      {uiText(
                                        money(
                                          product.price +
                                            (category === "디카페인" &&
                                            !product.decafOnly
                                              ? 500
                                              : 0),
                                        ),
                                      )}
                                    </span>
                                  </button>
                                )),
                            )}
                          </div>
                          <p className="catalog-end">
                            {uiText("원하는 메뉴를 선택해 주세요.")}
                          </p>
                        </div>
                        <section
                          className="order-dock"
                          aria-label={uiText("현재 주문 내역")}
                        >
                          <div className="dock-heading">
                            <h2>
                              {uiText("주문 내역 ")}
                              <em>{uiText(count)}</em>
                            </h2>
                            <div>
                              <button
                                disabled={!cart.length}
                                onClick={() => setOverlay("clear")}
                              >
                                {uiText("전체 삭제")}
                              </button>
                            </div>
                          </div>
                          <div className="dock-body">
                            <div
                              className="dock-lines"
                              ref={dockScroll}
                              tabIndex={0}
                              aria-label={uiText("주문한 메뉴 목록")}
                            >
                              {uiText(
                                cart.length ? (
                                  cart.map((line) => {
                                    const product = findProduct(
                                      line.productId,
                                    )!;
                                    return (
                                      <div className="dock-line" key={line.id}>
                                        <button
                                          className="dock-item"
                                          aria-label={uiText(
                                            `${product.name} 옵션 변경`,
                                          )}
                                          onClick={() =>
                                            configure(product, line)
                                          }
                                        >
                                          <strong>
                                            {uiText(product.name)}
                                          </strong>
                                          <span>
                                            {uiText(summary(line.options))}
                                          </span>
                                        </button>
                                        <Counter
                                          label={`${product.name} 주문 수량`}
                                          value={line.quantity}
                                          onChange={(n) =>
                                            changeQuantity(line, n)
                                          }
                                        />
                                        <b>
                                          {uiText(
                                            money(
                                              unitPrice(product, line.options) *
                                                line.quantity,
                                            ),
                                          )}
                                        </b>
                                        <button
                                          className="dock-delete"
                                          aria-label={uiText(
                                            `${product.name} 주문에서 삭제`,
                                          )}
                                          onClick={() =>
                                            setCart(
                                              cart.filter(
                                                (l) => l.id !== line.id,
                                              ),
                                            )
                                          }
                                        >
                                          <X size={19} />
                                        </button>
                                      </div>
                                    );
                                  })
                                ) : (
                                  <div className="dock-empty">
                                    {uiText(
                                      "메뉴를 담으면 여기에 주문 내역이 보여요.",
                                    )}
                                  </div>
                                ),
                              )}
                            </div>
                            <div className="dock-scroll-buttons">
                              <button
                                aria-label={uiText("주문 내역 위로")}
                                disabled={!dockPosition.up}
                                onClick={() =>
                                  dockScroll.current?.scrollBy({
                                    top: -160,
                                    behavior: "smooth",
                                  })
                                }
                              >
                                <ChevronUp size={26} />
                              </button>
                              <button
                                aria-label={uiText("주문 내역 아래로")}
                                disabled={!dockPosition.down}
                                onClick={() =>
                                  dockScroll.current?.scrollBy({
                                    top: 160,
                                    behavior: "smooth",
                                  })
                                }
                              >
                                <ChevronDown size={26} />
                              </button>
                            </div>
                          </div>
                          <footer className="cart-bar">
                            <button
                              className="text-button"
                              onClick={() =>
                                cart.length ? setOverlay("cancel") : reset()
                              }
                            >
                              {uiText("주문 취소")}
                            </button>
                            <div className="cart-tally">
                              <span>
                                {uiText("총 ")}
                                {uiText(count)}
                                {uiText("개")}
                              </span>
                              <strong>{uiText(money(total))}</strong>
                            </div>
                            <button
                              className="primary"
                              disabled={!cart.length}
                              onClick={() => setScreen("cart")}
                            >
                              {uiText("결제하기")}
                              <ArrowRight size={21} />
                            </button>
                          </footer>
                        </section>
                      </>
                    ) : screen === "cart" ? (
                      <section className="cart-screen">
                        <div className="screen-heading">
                          <span className="eyebrow">
                            {uiText("선택한 메뉴를 확인해 주세요")}
                          </span>
                          <h1>
                            {uiText("주문 내역 ")}
                            <em>{uiText(count)}</em>
                          </h1>
                        </div>
                        <div className="review-list-body">
                          <div
                            className="cart-lines"
                            ref={reviewScroll}
                            tabIndex={0}
                            aria-label={uiText("확인할 주문 목록")}
                          >
                            {uiText(
                              cart.map((line) => {
                                const product = findProduct(line.productId)!;
                                return (
                                  <article className="cart-line" key={line.id}>
                                    <div className="cart-photo">
                                      <ProductImage
                                        product={product}
                                        temperature={line.options.temperature}
                                      />
                                    </div>
                                    <div className="cart-detail">
                                      <h2>{uiText(product.name)}</h2>
                                      <p>{uiText(summary(line.options))}</p>
                                      <button
                                        className="option-edit"
                                        aria-label={uiText(
                                          `${product.name} 옵션 변경`,
                                        )}
                                        onClick={() => configure(product, line)}
                                      >
                                        {uiText("옵션 변경")}
                                      </button>
                                      <div className="cart-line-bottom">
                                        <Counter
                                          value={line.quantity}
                                          label={`${product.name} 수량`}
                                          onChange={(n) =>
                                            changeQuantity(line, n)
                                          }
                                        />
                                        <strong>
                                          {uiText(
                                            money(
                                              unitPrice(product, line.options) *
                                                line.quantity,
                                            ),
                                          )}
                                        </strong>
                                      </div>
                                    </div>
                                    <button
                                      className="remove-button"
                                      aria-label={uiText(
                                        `${product.name} 삭제`,
                                      )}
                                      onClick={() =>
                                        setCart(
                                          cart.filter((l) => l.id !== line.id),
                                        )
                                      }
                                    >
                                      <X size={21} />
                                    </button>
                                  </article>
                                );
                              }),
                            )}
                            {uiText(
                              !cart.length && (
                                <div className="empty-cart">
                                  <ShoppingBasket size={62} />
                                  <h2>{uiText("아직 담은 메뉴가 없어요")}</h2>
                                  <p>
                                    {uiText("마음에 드는 메뉴를 골라 보세요.")}
                                  </p>
                                </div>
                              ),
                            )}
                            <button
                              className="add-more"
                              onClick={() => setScreen("menu")}
                            >
                              <Plus size={21} />
                              {uiText("메뉴 더 담기")}
                            </button>
                          </div>
                          <div className="dock-scroll-buttons review-scroll-buttons">
                            <button
                              aria-label={uiText("주문 확인 목록 위로")}
                              disabled={!reviewPosition.up}
                              onClick={() =>
                                reviewScroll.current?.scrollBy({
                                  top: -250,
                                  behavior: "smooth",
                                })
                              }
                            >
                              <ChevronUp size={26} />
                            </button>
                            <button
                              aria-label={uiText("주문 확인 목록 아래로")}
                              disabled={!reviewPosition.down}
                              onClick={() =>
                                reviewScroll.current?.scrollBy({
                                  top: 250,
                                  behavior: "smooth",
                                })
                              }
                            >
                              <ChevronDown size={26} />
                            </button>
                          </div>
                        </div>
                        <div className="cart-checkout">
                          <div>
                            <span>
                              {uiText("총 ")}
                              {uiText(count)}
                              {uiText("개")}
                            </span>
                            <strong>{uiText(money(total))}</strong>
                          </div>
                          <p>
                            {uiText(
                              "선택하신 메뉴와 옵션이 맞는지 확인해 주세요.",
                            )}
                          </p>
                          <div className="review-actions">
                            <button
                              className="secondary"
                              onClick={() => setScreen("menu")}
                            >
                              <ArrowLeft size={23} />
                              {uiText("이전으로")}
                            </button>
                            <button
                              className="primary"
                              disabled={!cart.length}
                              onClick={() => setScreen("payment")}
                            >
                              {uiText("확인하고 결제하기")}
                              <ArrowRight size={23} />
                            </button>
                          </div>
                        </div>
                      </section>
                    ) : (
                      <section className="payment-screen">
                        <div className="screen-heading">
                          <span className="eyebrow">
                            {uiText("주문이 거의 끝났어요")}
                          </span>
                          <h1>
                            {uiText("결제수단을")}
                            <br />
                            {uiText("선택해 주세요")}
                          </h1>
                        </div>
                        <div className="payment-total">
                          <span>{uiText("결제할 금액")}</span>
                          <strong>{uiText(money(total))}</strong>
                          <span>
                            {uiText(placeName(place))}
                            {uiText(" · 메뉴 ")}
                            {uiText(count)}
                            {uiText("개")}
                          </span>
                        </div>
                        <div className="payment-methods">
                          {uiText(
                            paymentMethods.map(
                              ({ method, description, mark }) => (
                                <button
                                  key={method}
                                  className={`payment-method ${method}`}
                                  aria-label={uiText(methodName(method))}
                                  onClick={() => {
                                    setToast("");
                                    processing.current = false;
                                    setPayment({
                                      method,
                                      status: "waiting",
                                      attempt: crypto.randomUUID(),
                                    });
                                  }}
                                >
                                  <span className="method-symbol">
                                    {uiText(
                                      method === "card" ? (
                                        <CreditCard size={32} />
                                      ) : (
                                        mark
                                      ),
                                    )}
                                  </span>
                                  <span className="method-copy">
                                    <strong>
                                      {uiText(methodName(method))}
                                    </strong>
                                    <small>{uiText(description)}</small>
                                  </span>
                                  {uiText(
                                    method === "card" && (
                                      <ArrowRight size={24} />
                                    ),
                                  )}
                                </button>
                              ),
                            ),
                          )}
                        </div>
                        <p className="payment-guidance">
                          {uiText(
                            "결제수단을 선택한 뒤, 리더기 안내에 따라 주세요.",
                          )}
                        </p>
                        <button
                          className="secondary full"
                          onClick={() => setScreen("cart")}
                        >
                          <ArrowLeft size={21} />
                          {uiText("주문 내역 다시 보기")}
                        </button>
                      </section>
                    ),
                  )}
                </>
              ),
            )}

            {uiText(
              toast && (
                <div className="toast" role="status">
                  <CheckCircle2 size={20} />
                  {uiText(toast)}
                </div>
              ),
            )}
            {uiText(
              storageError && (
                <div className="storage-warning" role="alert">
                  {uiText(
                    "주문 임시 저장을 사용할 수 없어요. 브라우저 저장 공간을 확인해 주세요.",
                  )}
                </div>
              ),
            )}

            {uiText(
              overlay ? (
                <Modal
                  title={uiText(
                    overlay === "shutdown"
                      ? "키오스크 종료"
                      : overlay === "receipt"
                        ? "영수증"
                        : overlay === "printer"
                          ? "프린터 설정"
                          : overlay === "history"
                            ? "이 기기의 주문 이력"
                            : overlay === "place"
                              ? "이용 방법 변경"
                              : overlay === "help"
                                ? "직원 도움 요청"
                                : overlay === "idle"
                                  ? "주문을 계속할까요?"
                                  : overlay === "clear"
                                    ? "주문 내역을 비울까요?"
                                    : "주문을 취소할까요?",
                  )}
                  onClose={closeOverlay}
                  closeDisabled={overlay === "shutdown" && exitPending}
                  dismissOnBackdrop={overlay !== "shutdown"}
                  className={
                    overlay === "history"
                      ? "history-modal"
                      : overlay === "receipt"
                        ? "receipt-modal"
                        : overlay === "printer"
                          ? "printer-settings-modal"
                          : ""
                  }
                >
                  {uiText(
                    overlay === "shutdown" ? (
                      <div className="message-body exit-dialog-body">
                        <div className="message-icon">
                          <Power size={33} />
                        </div>
                        <h2>
                          {uiText(
                            exitPending
                              ? "키오스크를 종료하고 있어요"
                              : "종료하시겠습니까?",
                          )}
                        </h2>
                        <p>
                          {uiText(
                            exitPending
                              ? "진행 중인 출력과 연결된 프로그램을 정리하고 있어요.\n잠시만 기다려 주세요."
                              : "키오스크 화면과 연결된 프로그램을 정리한 뒤 종료해요.",
                          )}
                        </p>
                        {uiText(
                          exitError && (
                            <div className="exit-error" role="alert">
                              {uiText(exitError)}
                            </div>
                          ),
                        )}
                        <div className="button-pair">
                          <button
                            className="secondary"
                            disabled={exitPending}
                            onClick={closeOverlay}
                          >
                            {uiText("아니요")}
                          </button>
                          <button
                            className="primary"
                            disabled={exitPending}
                            onClick={() => void confirmExit()}
                          >
                            {uiText(exitPending ? "종료 중" : "예")}
                          </button>
                        </div>
                      </div>
                    ) : overlay === "cancel" || overlay === "clear" ? (
                      <div className="message-body">
                        <div className="message-icon">
                          <ShoppingBag />
                        </div>
                        <h2>{uiText("담아 둔 메뉴가 모두 지워져요.")}</h2>
                        <p>
                          {uiText(
                            overlay === "clear"
                              ? "선택한 메뉴를 모두 삭제할까요?"
                              : "주문을 취소하고 처음 화면으로 돌아갈까요?",
                          )}
                        </p>
                        <div className="button-pair">
                          <button className="secondary" onClick={closeOverlay}>
                            {uiText("계속 주문하기")}
                          </button>
                          <button
                            className="primary"
                            onClick={() => {
                              if (overlay === "clear") {
                                setCart([]);
                                closeOverlay();
                              } else reset();
                            }}
                          >
                            {uiText(
                              overlay === "clear"
                                ? "전체 삭제하기"
                                : "주문 취소하기",
                            )}
                          </button>
                        </div>
                      </div>
                    ) : overlay === "place" ? (
                      <div className="message-body">
                        <h2>{uiText("어디서 즐기실 건가요?")}</h2>
                        <p>
                          {uiText("담아 둔 메뉴와 옵션은 그대로 유지돼요.")}
                        </p>
                        <div className="button-pair">
                          {uiText(
                            (["store", "takeout"] as const).map((p) => (
                              <button
                                key={p}
                                className={
                                  place === p ? "primary" : "secondary"
                                }
                                onClick={() => {
                                  setPlace(p);
                                  closeOverlay();
                                }}
                              >
                                {uiText(
                                  p === "store" ? <Store /> : <ShoppingBag />,
                                )}
                                {uiText(placeName(p))}
                              </button>
                            )),
                          )}
                        </div>
                      </div>
                    ) : overlay === "help" ? (
                      <div className="message-body">
                        <div className="message-icon">
                          <CircleHelp />
                        </div>
                        <h2>
                          {uiText(
                            helpRequested
                              ? "도움 요청을 표시했어요"
                              : "천천히 주문하셔도 괜찮아요.",
                          )}
                        </h2>
                        <p>
                          {uiText(
                            helpRequested
                              ? "이 시제품에서는 직원 단말기로 전송되지 않아요.\n필요하면 가까운 직원에게 말씀해 주세요."
                              : "도움이 필요하시면 직원을 불러 주세요.\n담아 둔 메뉴는 그대로 유지돼요.",
                          )}
                        </p>
                        <button
                          className="primary full"
                          onClick={() => {
                            if (helpRequested) closeOverlay();
                            else setHelpRequested(true);
                          }}
                        >
                          {uiText(
                            helpRequested ? "확인했어요" : "직원 도움 요청하기",
                          )}
                        </button>
                      </div>
                    ) : overlay === "idle" ? (
                      <div className="message-body">
                        <div className="message-icon">
                          <Clock3 />
                        </div>
                        <h2>{uiText("주문을 계속할까요?")}</h2>
                        <p>
                          {uiText(idleSeconds)}
                          {uiText("초 후에는 담은 메뉴가 지워지고")}
                          <br />
                          {uiText("처음 화면으로 돌아가요.")}
                        </p>
                        <div className="button-pair">
                          <button className="secondary" onClick={reset}>
                            {uiText("주문 마치기")}
                          </button>
                          <button className="primary" onClick={closeOverlay}>
                            {uiText("계속 주문할게요")}
                          </button>
                        </div>
                      </div>
                    ) : overlay === "history" ? (
                      <div className="history-list">
                        {uiText(
                          !history.length ? (
                            <div className="empty-cart">
                              <ReceiptText size={40} />
                              <h2>{uiText("아직 완료한 주문이 없어요.")}</h2>
                            </div>
                          ) : (
                            history.map((o) => (
                              <button
                                key={o.id}
                                onClick={() => {
                                  setReceiptSample(false);
                                  setReceiptOrder(o);
                                  setOverlay("receipt");
                                }}
                              >
                                <span>
                                  <b>
                                    {uiText("주문 ")}
                                    {uiText(o.number)}
                                  </b>
                                  <small>
                                    {uiText(
                                      new Date(o.createdAt).toLocaleString(
                                        "ko-KR",
                                      ),
                                    )}{" "}
                                    ·{uiText(" ")}
                                    {uiText(placeName(o.place))}
                                  </small>
                                </span>
                                <strong>{uiText(money(o.total))}</strong>
                              </button>
                            ))
                          ),
                        )}
                      </div>
                    ) : overlay === "printer" ? (
                      <PrinterSettingsPanel
                        value={printerSettings}
                        onClose={closeOverlay}
                        onSave={(value) => {
                          setPrinterSettings(value);
                          setOverlay(null);
                          setToast("프린터 설정을 저장했어요.");
                        }}
                      />
                    ) : (
                      receipt && (
                        <ReceiptPreview
                          soundSettings={printerSettings}
                          order={receipt}
                          sample={receiptSample}
                          onClose={closeOverlay}
                          onSettings={() => setOverlay("printer")}
                        />
                      )
                    ),
                  )}
                </Modal>
              ) : editor ? (
                <Modal
                  title={uiText(editor.lineId ? "메뉴 수정" : "메뉴 선택")}
                  onClose={() => setEditor(null)}
                  className="option-modal"
                >
                  <div className="option-intro">
                    <div className="option-photo">
                      <ProductImage
                        product={editor.product}
                        temperature={editor.options.temperature}
                      />
                    </div>
                    <div>
                      <span className="eyebrow">SWitch COFFEE</span>
                      <h2>{uiText(editor.product.name)}</h2>
                      <p>{uiText(editor.product.description)}</p>
                      <strong>{uiText(money(editor.product.price))}</strong>
                    </div>
                  </div>
                  <div className="option-scroll">
                    <div className="option-group">
                      <h3>
                        {uiText("온도 ")}
                        <span className="required">{uiText("필수")}</span>
                      </h3>
                      {uiText(
                        optionButtons(
                          "temperature",
                          editor.product.temperatures.map((temperature) => ({
                            value: temperature,
                            label:
                              temperature === "ice" ? "차갑게" : "따뜻하게",
                            extra:
                              temperature === "ice"
                                ? editor.product.temperatures.length === 1
                                  ? "ICE ONLY"
                                  : "ICE"
                                : editor.product.temperatures.length === 1
                                  ? "HOT ONLY"
                                  : "HOT",
                          })),
                        ),
                      )}
                    </div>
                    {uiText(
                      !editor.product.fixedSize && (
                        <div className="option-group">
                          <h3>{uiText("사이즈")}</h3>
                          {uiText(
                            optionButtons("size", [
                              {
                                value: "regular",
                                label: "레귤러",
                                extra: "기본",
                              },
                              {
                                value: "large",
                                label: "라지",
                                extra: "+500원",
                              },
                            ]),
                          )}
                        </div>
                      ),
                    )}
                    {uiText(
                      editor.product.fixedOptions && (
                        <p className="fixed-options-note">
                          {uiText(
                            "이 메뉴는 온도와 구성이 정해져 있어요. 수량을 선택해 주세요.",
                          )}
                        </p>
                      ),
                    )}
                    {uiText(
                      editor.product.decaf && !editor.product.decafOnly && (
                        <div className="option-group">
                          <h3>{uiText("원두")}</h3>
                          {uiText(
                            optionButtons("decaf", [
                              { value: false, label: "기본 원두" },
                              {
                                value: true,
                                label: "디카페인",
                                extra: "+500원",
                              },
                            ]),
                          )}
                        </div>
                      ),
                    )}
                    {uiText(
                      editor.product.milk && !editor.product.fixedOptions && (
                        <div className="option-group">
                          <h3>{uiText("우유")}</h3>
                          {uiText(
                            optionButtons("milk", [
                              { value: "regular", label: "일반 우유" },
                              {
                                value: "oat",
                                label: "오트밀크",
                                extra: "+600원",
                              },
                            ]),
                          )}
                        </div>
                      ),
                    )}
                    {uiText(
                      editor.options.temperature === "ice" &&
                        editor.product.iceAdjustable && (
                          <div className="option-group">
                            <h3>{uiText("얼음")}</h3>
                            {uiText(
                              optionButtons("ice", [
                                { value: "normal", label: "기본" },
                                { value: "more", label: "많이" },
                                { value: "less", label: "적게" },
                                { value: "none", label: "없이" },
                              ]),
                            )}
                          </div>
                        ),
                    )}
                    {uiText(
                      !editor.product.fixedOptions && (
                        <div className="option-group">
                          <h3>{uiText("당도")}</h3>
                          {uiText(
                            optionButtons("sweetness", [
                              { value: "normal", label: "기본" },
                              { value: "less", label: "덜 달게" },
                              { value: "none", label: "시럽 없이" },
                            ]),
                          )}
                        </div>
                      ),
                    )}
                    {uiText(
                      editor.product.whippedCream &&
                        !editor.product.fixedOptions && (
                          <div className="option-group">
                            <h3>{uiText("휘핑크림")}</h3>
                            {uiText(
                              optionButtons("whippedCream", [
                                { value: "normal", label: "기본" },
                                { value: "extra", label: "휘핑 추가" },
                                { value: "none", label: "휘핑 제거" },
                              ]),
                            )}
                          </div>
                        ),
                    )}
                    {uiText(
                      editor.product.coffee && !editor.product.fixedOptions && (
                        <div className="option-group option-counter">
                          <div>
                            <h3>{uiText("샷 추가")}</h3>
                            <p>{uiText("1샷당 +500원")}</p>
                          </div>
                          <Counter
                            label="추가 샷"
                            value={editor.options.shots}
                            min={0}
                            max={3}
                            onChange={(n) => editOption("shots", n)}
                          />
                        </div>
                      ),
                    )}
                    {uiText(
                      !editor.product.fixedOptions && (
                        <div className="option-group option-counter">
                          <div>
                            <h3>{uiText("시럽 추가")}</h3>
                            <p>{uiText("1회당 +300원")}</p>
                          </div>
                          <Counter
                            label="추가 시럽"
                            value={editor.options.syrup}
                            min={0}
                            max={3}
                            onChange={(n) => editOption("syrup", n)}
                          />
                        </div>
                      ),
                    )}
                  </div>
                  <div className="option-footer">
                    {uiText(
                      editor.error && (
                        <div className="inline-error" role="alert">
                          <TriangleAlert size={17} />
                          {uiText(editor.error)}
                        </div>
                      ),
                    )}
                    <div className="option-quantity">
                      <span>{uiText("수량")}</span>
                      <Counter
                        label="메뉴 수량"
                        value={editor.quantity}
                        onChange={(n) => setEditor({ ...editor, quantity: n })}
                      />
                    </div>
                    <button className="primary full" onClick={add}>
                      {uiText(
                        money(
                          unitPrice(editor.product, editor.options) *
                            editor.quantity,
                        ),
                      )}
                      {uiText(" ")}
                      {uiText(editor.lineId ? "수정하기" : "담기")}
                      <Plus size={22} />
                    </button>
                  </div>
                </Modal>
              ) : (
                payment && (
                  <PaymentPanel
                    payment={payment}
                    total={total}
                    onStart={beginPayment}
                    onCancel={cancelPayment}
                    onRetry={() =>
                      setPayment({
                        ...payment,
                        status: "waiting",
                        attempt: crypto.randomUUID(),
                      })
                    }
                  />
                )
              ),
            )}
          </main>
        </div>
      </div>
      {uiText(
        !standalone && (
          <div className="studio-footer">
            <span>{uiText("1600 × 2560 · 세로형")}</span>
            <span>
              {uiText("메뉴·옵션·주문 내역·결제 흐름을 직접 터치해 보세요.")}
            </span>
            <button
              onClick={() => {
                if (cart.length) setOverlay("cancel");
                else reset();
              }}
            >
              <RotateCcw size={13} />
              {uiText("처음부터")}
            </button>
          </div>
        ),
      )}
      {uiText(
        order && (
          <AutoReceiptPrinter
            order={order}
            settings={printerSettings}
            onPhase={(state, message) => setAutoPrint({ state, message })}
          />
        ),
      )}
    </div>
  );
}
