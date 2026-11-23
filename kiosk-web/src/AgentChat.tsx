import { uiText } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KioskCompanion } from "./KioskCompanion";
import { attendantState, type VoiceInputState } from "./attendantState";
import { Send, RotateCcw, Square, Volume2, VolumeX } from "lucide-react";
import { assetUrl } from "./catalog";
import type { Payment } from "./PaymentFlow";
import type { PaymentAction } from "./agentCheckout";
import type { CartLine, Place, PaymentMethod } from "./domain";
import "./agent-chat.css";
import {
  AgentGuidance,
  type Guidance,
  type GuidanceState,
} from "./AgentGuidance";
import type { UiEvent } from "./agentUiEvents";
import {
  mergeUsage,
  formatEstimatedCost,
  type UsageReport,
} from "./agentUsage";
import { AgentSpeech } from "./agentSpeech";
import { streamAgentAudio, unlockAgentAudio } from "./agentAudio";

export type ChatCart = {
  lines: CartLine[];
  place: Place | null;
  screen: "home" | "menu" | "cart" | "payment" | "finalizing" | "completed";
  payment?: Payment | null;
  receipt?: {
    id: string;
    number: string;
    total: number;
    method: PaymentMethod;
  } | null;
  last_action_id?: string | null;
  ui_context?: {
    language?: string;
    guidance?: GuidanceState | null;
    interaction?: {
      activations: number;
      option_changes: number;
      screen_changes: number;
      guidance_completed: number;
      started_at: number;
      last_action_at: number | null;
      recent_actions: string[];
      idle_ms?: number | null;
      session_elapsed_ms?: number;
    };
    category: string;
    events?: UiEvent[];
    overlay: string | null;
    editor: {
      product_id: string;
      quantity: number;
      options: CartLine["options"];
      line_id?: string;
    } | null;
  };
};
export type AgentState = {
  language?: string;
  ui_context?: ChatCart["ui_context"];
  guidance?: Guidance | null;
  focus?: string | null;
  item_drafts?: {
    product_id: string;
    quantity: number;
    options: CartLine["options"];
    next_option: string;
    question?: string;
  }[];
  phase: "ordering" | "checkout" | "handoff" | "completed";
  view?: "menu" | "review" | "payment";
  confirmation_pending?: boolean;
  payment_action?: PaymentAction | null;
  place: Place | null;
  lines: {
    id: string;
    product_id: string;
    quantity: number;
    options: CartLine["options"];
  }[];
  total: number;
};
type Status = { ready: boolean; token: string; message: string };
type Message = {
  role: "assistant" | "user";
  text: string;
  id?: string;
  usage?: UsageReport;
  elapsed_ms?: number;
  status?: "streaming" | "complete" | "interrupted";
};
type Pending = {
  request_id: string;
  text: string;
  cart: ChatCart;
  session: string;
  payment_event?: boolean;
  started_at?: number;
};
type Result = {
  ok: boolean;
  code?: string;
  text?: string;
  error?: string;
  state?: AgentState;
  session_complete?: boolean;
  usage?: UsageReport;
  timing?: { response_ms: number; first_text_ms: number | null };
};
type StreamEvent = Result & {
  type: "text.delta" | "final" | "error" | "interrupted";
  sequence: number;
  needs_delivery?: boolean;
};
// Share a pending cancellation across overlapping submissions for this speaker.
const interruptionBarriers = new WeakMap<AgentSpeech, Promise<void>>();

const greeting: Message = {
  id: "greeting",
  role: "assistant",
  text: "안녕하세요. 무엇을 드릴까요?",
};

async function request<T>(
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(assetUrl(`agent-api/${path}`), {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Switch-Agent-Token": token ?? "",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 5000 : 105000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new TypeError("Agent connection interrupted");
  }
  if (!response.ok)
    throw new Error(data.error || "에이전트 서버에 연결하지 못했어요.");
  return data as T;
}

export function AgentChat({
  cart,
  disabled,
  onState,
  onBeginOrdering,
  onConversationActiveChange,
  onSessionEnd,
  previousUsage,
  guidance,
  onGuideDone,
  onGuideDismiss,
  voiceInput,
}: {
  cart: ChatCart;
  disabled: boolean;
  onState: (state: AgentState) => void;
  onBeginOrdering: () => void;
  onConversationActiveChange: (active: boolean) => void;
  onSessionEnd: (usage?: UsageReport) => void;
  previousUsage?: UsageReport | null;
  guidance: GuidanceState | null;
  onGuideDone: () => void;
  onGuideDismiss: () => void;
  voiceInput?: VoiceInputState;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const current = useRef(cart);
  current.current = cart;
  const open = true;
  const [messages, setMessages] = useState<Message[]>([greeting]);
  const [text, setText] = useState("");
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const latestUsage = useRef<UsageReport | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [playback, setPlayback] = useState({ active: false, level: 0 });
  const historyOpen = false;
  const [companionSlot, setCompanionSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setCompanionSlot(document.querySelector<HTMLElement>(".kiosk"));
  }, []);

  const [ttsEnabled, setTtsEnabled] = useState(true);
  const speech = useRef<AgentSpeech | null>(null);
  if (!speech.current)
    speech.current = new AgentSpeech(setSpeaking, () =>
      setError("음성 재생을 중단했어요. 화면의 안내로 계속 진행할게요."),
    );
  const latestConnection = useRef({ session, token: status?.token });
  latestConnection.current = { session, token: status?.token };
  const generation = useRef(0);
  const submissionSequence = useRef(0);
  const activeRequest = useRef<{
    session: string;
    request: string;
    cart: ChatCart;
  } | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const cursor = useRef(0);
  const delivery = useRef<{ session: string; request: string } | null>(null);

  useEffect(
    () => () => {
      streamAbort.current?.abort();
      speech.current?.stop();
      const latest = latestConnection.current;
      if (latest.session && latest.token)
        void request(`sessions/${latest.session}/end`, latest.token, {}).catch(
          () => {},
        );
    },
    [],
  );

  const submitLatest = useRef(submit);
  submitLatest.current = submit;
  const seenPaymentNotices = useRef(new Set<string>());
  useEffect(() => {
    const key = cart.receipt
      ? `complete:${cart.receipt.id}`
      : cart.payment && ["failure", "timeout"].includes(cart.payment.status)
        ? `${cart.payment.attempt}:${cart.payment.status}`
        : null;
    if (
      !key ||
      !session ||
      !status?.ready ||
      !open ||
      busy ||
      seenPaymentNotices.current.has(key)
    )
      return;
    seenPaymentNotices.current.add(key);
    void submitLatest.current(undefined, true);
  }, [
    cart.receipt?.id,
    cart.payment?.attempt,
    cart.payment?.status,
    session,
    status?.ready,
    open,
    busy,
  ]);

  function recordUsage(requestId: string, report: UsageReport) {
    latestUsage.current = mergeUsage(latestUsage.current, report);
    setUsage(latestUsage.current);
    setMessages((previous) =>
      previous.map((message) =>
        message.id === requestId ? { ...message, usage: report } : message,
      ),
    );
  }

  async function connect() {
    setChecking(true);
    setError("");
    try {
      const fresh = await request<Status>("status");
      setStatus(fresh);
      if (status && fresh.token !== status.token) {
        speech.current!.stop();
        delivery.current = null;
        generation.current++;
        streamAbort.current?.abort();
        sending.current = false;
        setBusy(false);
        setPending(null);
        setSession(null);
        setError(
          "서버에 다시 연결했어요. 담긴 주문은 유지돼요. 결제 전에는 주문을 다시 확인할게요.",
        );
      }
    } catch {
      setStatus(null);
      setError(
        "중앙 에이전트 서버에 연결하지 못했어요. 잠시 뒤 다시 연결해 주세요.",
      );
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (open) {
      void connect();
      input.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    onConversationActiveChange(!!session);
  }, [session, onConversationActiveChange]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [messages, busy, error, historyOpen]);

  function apply(state: AgentState, languageAtRequest?: string) {
    const preferred = current.current.ui_context?.language;
    if (preferred && languageAtRequest && preferred !== languageAtRequest)
      state = { ...state, language: preferred };
    onState(state);
    current.current = {
      ...current.current,
      lines: state.lines.map((line) => ({
        id: line.id,
        productId: line.product_id,
        quantity: line.quantity,
        options: line.options,
      })),
      place: state.place,
      screen:
        state.phase === "checkout"
          ? "payment"
          : state.view === "review" || state.confirmation_pending
            ? "cart"
            : state.view === "menu" || state.place || state.lines.length > 0
              ? current.current.screen === "cart"
                ? "cart"
                : "menu"
              : "home",
    };
  }

  async function acknowledge() {
    const target = delivery.current;
    const ownGeneration = generation.current;
    if (!target || !status) return;
    try {
      await request(`sessions/${target.session}/delivered`, status.token, {
        request_id: target.request,
      });
      if (delivery.current === target) delivery.current = null;
    } catch {
      if (generation.current === ownGeneration)
        setError(
          "주문 안내 전달을 확인하지 못했어요. 현재 주문으로 다시 확인할게요.",
        );
    }
  }

  async function interrupt(replyText?: string) {
    const barrier = interruptionBarriers.get(speech.current!);
    if (barrier) return barrier;
    const ownGeneration = ++generation.current;
    const target = activeRequest.current;
    activeRequest.current = null;
    const confirmationVisible =
      !!target && delivery.current?.request === target.request;
    const before = JSON.stringify([
      current.current.lines,
      current.current.place,
    ]);
    const canApply =
      !!target &&
      before === JSON.stringify([target.cart.lines, target.cart.place]);
    speech.current!.stop();
    setPlayback({ active: false, level: 0 });
    delivery.current = null;
    streamAbort.current?.abort();
    sending.current = false;
    setBusy(false);
    setPending(null);
    if (target)
      setMessages((previous) =>
        previous.map((message) =>
          message.id === target.request && message.status === "streaming"
            ? { ...message, status: "interrupted" }
            : message,
        ),
      );
    const stopping = (async () => {
      if (!target || !status) return;
      const result = await request<Result>(
        `sessions/${target.session}/interrupt`,
        status.token,
        {
          request_id: target.request,
          reply_text: replyText,
          confirmation_visible: confirmationVisible,
        },
      );
      if (generation.current !== ownGeneration) return;
      if (result.usage) recordUsage(target.request, result.usage);
      if (
        result.state &&
        canApply &&
        before ===
          JSON.stringify([current.current.lines, current.current.place]) &&
        !["finalizing", "completed"].includes(current.current.screen)
      )
        apply(result.state, target.cart.ui_context?.language);
    })();
    interruptionBarriers.set(speech.current!, stopping);
    try {
      await stopping;
    } finally {
      if (interruptionBarriers.get(speech.current!) === stopping)
        interruptionBarriers.delete(speech.current!);
    }
  }

  async function submit(retry?: Pending, paymentEvent = false) {
    if (disabled && !paymentEvent) return;
    const submission = ++submissionSequence.current;
    const submittedAt = performance.now();
    if (!retry && !paymentEvent && current.current.screen === "home") {
      onBeginOrdering();
      current.current = { ...current.current, screen: "menu" };
    }
    if (ttsEnabled) unlockAgentAudio();
    if (!status?.ready || (!retry && !paymentEvent && !text.trim())) return;
    if (
      sending.current ||
      speaking ||
      delivery.current ||
      interruptionBarriers.has(speech.current!)
    ) {
      try {
        await interrupt(
          paymentEvent ? undefined : (retry?.text ?? text.trim()),
        );
      } catch {
        setError("주문 상태를 확인하지 못했어요. 다시 연결해 주세요.");
        return;
      }
    } else if (pending && !retry) return;
    if (submission !== submissionSequence.current) return;
    sending.current = true;
    const turnGeneration = generation.current;
    setBusy(true);
    setError("");
    let operation = retry;
    try {
      let id = retry?.session ?? latestConnection.current.session ?? session;
      if (!id) {
        latestUsage.current = null;
        setUsage(null);
        id = (
          await request<{ session_id: string }>("sessions", status.token, {})
        ).session_id;
        latestConnection.current = { session: id, token: status.token };
        setSession(id);
      }
      if (generation.current !== turnGeneration) return;
      if (!operation) {
        operation = {
          request_id: crypto.randomUUID(),
          text: paymentEvent ? "키오스크 결제 결과 알림" : text.trim(),
          payment_event: paymentEvent,
          cart: structuredClone(current.current),
          session: id,
          started_at: submittedAt,
        };
        const interaction = operation.cart.ui_context?.interaction;
        if (interaction) {
          interaction.idle_ms =
            interaction.last_action_at === null
              ? null
              : Math.max(0, Date.now() - interaction.last_action_at);
          interaction.session_elapsed_ms = Math.max(
            0,
            Date.now() - interaction.started_at,
          );
        }
        if (!paymentEvent) {
          setMessages((previous) => [
            ...previous,
            { role: "user", text: operation!.text },
          ]);
          setText("");
        }
        cursor.current = 0;
        speech.current!.begin();
      }
      activeRequest.current = {
        session: id,
        request: operation.request_id,
        cart: operation.cart,
      };
      const audioSession = id;
      const audioRequest = operation.request_id;
      speech.current!.configure((text, signal) =>
        streamAgentAudio(
          assetUrl(`agent-api/sessions/${audioSession}/speech`),
          status.token,
          { request_id: audioRequest, text },
          signal,
          (report) => {
            if (latestConnection.current.session === audioSession)
              recordUsage(audioRequest, report);
          },
          (activity) => {
            if (
              latestConnection.current.session !== audioSession ||
              generation.current !== turnGeneration
            )
              return;
            const next = {
              active: activity.active,
              level: Math.round(activity.level * 10) / 10,
            };
            setPlayback((previous) =>
              previous.active === next.active && previous.level === next.level
                ? previous
                : next,
            );
          },
        ),
      );
      setPending(operation);
      const started = await request<Result>(
        `sessions/${id}/turns`,
        status.token,
        {
          request_id: operation.request_id,
          text: operation.text,
          cart: operation.cart,
          payment_event: operation.payment_event,
        },
      );
      if (generation.current !== turnGeneration) return;
      if (!started.ok) {
        setPending(null);
        if (started.code === "SESSION_EXPIRED") {
          setSession(null);
          speech.current!.stop();
          delivery.current = null;
        }
        throw new Error(started.error);
      }
      const abort = new AbortController();
      streamAbort.current = abort;
      const response = await fetch(
        assetUrl(
          `agent-api/sessions/${id}/turns/${operation.request_id}/events?after=${cursor.current}`,
        ),
        {
          headers: { "X-Switch-Agent-Token": status.token },
          signal: abort.signal,
        },
      );
      if (!response.ok || !response.body)
        throw new Error(
          "응답 스트림에 연결하지 못했어요. 같은 요청의 결과를 다시 확인해 주세요.",
        );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed = false;
      const setAssistant = (value: string, append: boolean) => {
        setMessages((previous) => {
          const next = [...previous];
          const index = next.findIndex(
            (message) => message.id === operation!.request_id,
          );
          if (index < 0)
            next.push({
              role: "assistant",
              text: value,
              id: operation!.request_id,
              status: append ? "streaming" : "complete",
            });
          else
            next[index] = {
              ...next[index],
              text: append ? next[index].text + value : value,
              status: append ? "streaming" : "complete",
            };
          return next;
        });
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (generation.current !== turnGeneration) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const row = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!row.trim()) continue;
          const event = JSON.parse(row) as StreamEvent;
          cursor.current = event.sequence ?? cursor.current;
          if (event.type === "text.delta" && event.text) {
            setAssistant(event.text, true);
            speech.current!.append(event.text);
          } else {
            completed = true;
            setPending(null);
            if (event.state && !operation.payment_event) {
              if (
                JSON.stringify([
                  current.current.lines,
                  current.current.place,
                ]) !==
                  JSON.stringify([
                    operation.cart.lines,
                    operation.cart.place,
                  ]) ||
                current.current.screen !== operation.cart.screen ||
                JSON.stringify(current.current.ui_context?.editor) !==
                  JSON.stringify(operation.cart.ui_context?.editor)
              ) {
                speech.current!.stop();
                delivery.current = null;
                setAssistant(
                  "화면에서 바꾸신 주문을 유지했어요. 이어서 말씀해 주세요.",
                  false,
                );
                if (event.usage) recordUsage(operation.request_id, event.usage);
                continue;
              }
              apply(event.state, operation.cart.ui_context?.language);
            }
            if (event.type === "final" && event.text) {
              setAssistant(event.text, false);
              const elapsed =
                operation.started_at === undefined
                  ? event.timing?.response_ms
                  : Math.round(performance.now() - operation.started_at);
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === operation!.request_id
                    ? { ...message, elapsed_ms: elapsed }
                    : message,
                ),
              );
              if (event.usage) recordUsage(operation.request_id, event.usage);
              if (event.needs_delivery)
                delivery.current = {
                  session: id,
                  request: operation.request_id,
                };
              speech.current!.finish(event.text, () => {
                void acknowledge();
                if (event.session_complete) {
                  void request(`sessions/${id}/end`, status.token, {}).catch(
                    () => {},
                  );
                  onSessionEnd(latestUsage.current ?? undefined);
                }
              });
            } else {
              speech.current!.stop();
              if (event.usage) recordUsage(operation.request_id, event.usage);
              if (event.error) setError(event.error);
            }
          }
        }
      }
      if (!completed)
        throw new Error(
          "연결이 끊겼어요. ‘응답 다시 확인’으로 이어받아 주세요.",
        );
    } catch (cause) {
      if (generation.current !== turnGeneration) return;
      if (cause instanceof Error && cause.name === "AbortError") return;
      speech.current!.stop();
      setPlayback({ active: false, level: 0 });
      delivery.current = null;
      if (operation)
        setMessages((previous) =>
          previous.map((message) =>
            message.id === operation!.request_id &&
            message.status === "streaming"
              ? { ...message, status: "interrupted" }
              : message,
          ),
        );
      try {
        const fresh = await request<Status>("status");
        if (generation.current !== turnGeneration) return;
        setStatus(fresh);
        if (fresh.token !== status.token) {
          setSession(null);
          setPending(null);
          speech.current!.stop();
          delivery.current = null;
          setError(
            "서버에 다시 연결했어요. 담긴 주문은 유지돼요. 마지막 요청은 자동 반복하지 않았어요.",
          );
          return;
        }
      } catch {
        /* Keep the same request ID for recovery when the server returns. */
      }
      setError(
        cause instanceof Error &&
          cause.name !== "TimeoutError" &&
          !(cause instanceof TypeError)
          ? cause.message
          : "연결이 끊겨 처리 결과를 아직 확인하지 못했어요. ‘응답 다시 확인’을 눌러 같은 요청의 결과를 확인해 주세요.",
      );
    } finally {
      if (generation.current === turnGeneration) {
        sending.current = false;
        setBusy(false);
      }
      input.current?.focus({ preventScroll: true });
    }
  }

  const presence = attendantState({
    ready: !!status?.ready,
    busy,
    speaking: playback.active,
    audioPending: speaking,
    typing: !!text.trim(),
    voice: voiceInput,
  });
  const latest = messages.at(-1);
  const caption = !status?.ready
    ? "점원을 연결하고 있어요. 잠시만 기다려 주세요."
    : latest?.role === "assistant"
      ? latest.text
      : "요청을 확인하고 있어요.";
  return (
    <>
      <AgentGuidance
        guide={guidance}
        onDone={onGuideDone}
        onDismiss={onGuideDismiss}
      />
      {companionSlot &&
        createPortal(
          <>
            <KioskCompanion
              kiosk={companionSlot}
              state={presence}
              level={playback.level}
              caption={caption}
              notice={error}
              conversation={messages.map((message) =>
                message.id === "greeting"
                  ? { ...message, text: uiText(message.text) }
                  : message,
              )}
              guidance={guidance}
              screen={cart.screen}
            />
            <section
              className="kiosk-conversation-history"
              hidden={!historyOpen}
              aria-label="대화 내역"
            >
              <div
                ref={log}
                hidden={!historyOpen}
                className="agent-chat-log"
                role="log"
                aria-label="주문 대화"
                aria-live="polite"
                aria-relevant="additions"
              >
                {messages.map((message, index) => (
                  <div
                    key={index}
                    className={`agent-chat-message ${message.role}`}
                  >
                    <span>
                      {message.role === "user" ? "나" : "SWitch 점원"}
                    </span>
                    <p>{message.text}</p>
                    {(message.usage || message.elapsed_ms !== undefined) && (
                      <small
                        className="agent-token-usage"
                        title="대화 모델의 모든 도구 호출을 합친 제공자 사용량. 입력에는 대화 이력·도구 결과·캐시가 포함됩니다."
                      >
                        {message.usage && (
                          <>
                            입력{" "}
                            {message.usage.turn.input_tokens.toLocaleString()} ·
                            출력{" "}
                            {message.usage.turn.output_tokens.toLocaleString()}{" "}
                            토큰
                            {message.usage.tts_turn
                              ? ` · 음성 ${message.usage.tts_turn.total_tokens.toLocaleString()}`
                              : ""}{" "}
                            ·{" "}
                            {formatEstimatedCost(
                              message.usage.turn,
                              message.usage.tts_turn,
                            )}
                          </>
                        )}
                        {message.elapsed_ms !== undefined && (
                          <span title="전송부터 최종 텍스트 수신까지의 시간입니다. 네트워크와 끼어들기 처리를 포함하며 TTS 재생은 제외합니다.">
                            {" "}
                            · 응답 {message.elapsed_ms.toLocaleString()} ms
                          </span>
                        )}
                      </small>
                    )}
                  </div>
                ))}
                {busy && (
                  <p className="agent-chat-thinking" role="status">
                    주문을 확인하고 있어요…
                  </p>
                )}
                <div ref={end} />
              </div>
            </section>
          </>,
          companionSlot,
        )}
      <aside className="agent-chat-pane" aria-label="STT 대용 테스트 입력">
        <div className="agent-test-console">
          <span className="agent-test-caption">STT 대용 입력</span>
          {!status?.ready && (
            <button disabled={checking} onClick={() => void connect()}>
              다시 연결
            </button>
          )}
          <form
            className="agent-chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="sr-only" htmlFor="agent-chat-input">
              주문 메시지
            </label>
            <textarea
              ref={input}
              id="agent-chat-input"
              placeholder="음성 대신 입력해 주세요"
              value={text}
              maxLength={4000}
              rows={1}
              disabled={disabled || (!busy && !!pending) || !status?.ready}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="submit"
              aria-label={
                busy || speaking ? "끼어들어 메시지 보내기" : "메시지 보내기"
              }
              disabled={
                disabled ||
                (!busy && !!pending) ||
                !status?.ready ||
                !text.trim()
              }
            >
              <Send size={21} />
            </button>
          </form>
          <div className="agent-chat-footer">
            <span>OpenAI AI 음성 · Enter 전송</span>
            <button
              disabled={disabled || busy || !!pending}
              onClick={() => {
                speech.current!.stop();
                delivery.current = null;
                if (session && status)
                  void request(
                    `sessions/${session}/end`,
                    status.token,
                    {},
                  ).catch(() => {});
                activeRequest.current = null;
                latestUsage.current = null;
                setUsage(null);
                setMessages([greeting]);
                setSession(null);
                setError("");
                setText("");
              }}
            >
              <RotateCcw size={14} /> 새 대화
            </button>
          </div>
          <div className="agent-chat-controls">
            <button
              disabled={!speech.current.supported}
              onClick={() => {
                const enabled = !ttsEnabled;
                setTtsEnabled(enabled);
                speech.current!.setEnabled(enabled);
                if (!enabled) void acknowledge();
              }}
            >
              {ttsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
              {!speech.current.supported
                ? "음성 미지원"
                : ttsEnabled
                  ? "음성 끄기"
                  : "음성 켜기"}
            </button>
            <button
              disabled={!busy && !speaking && !pending}
              onClick={() => {
                submissionSequence.current++;
                void interrupt().catch(() =>
                  setError(
                    "중단 상태를 확인하지 못했어요. 다시 연결해 주세요.",
                  ),
                );
              }}
            >
              <Square size={14} /> 말 끊기
            </button>
            <span>
              {speaking
                ? "읽어드리는 중"
                : busy
                  ? "답변 중에도 입력할 수 있어요"
                  : "텍스트 스트리밍"}
            </span>
          </div>
          <div
            className="agent-session-usage"
            aria-label="세션 토큰 사용량"
            title="실제 제공된 사용량만 집계합니다. 중단 후 제공되지 않은 토큰은 추정하지 않습니다. 비용은 OpenAI Standard 공개 단가의 USD 예상액이며 실제 청구서·세금·할인과 다를 수 있습니다."
          >
            <span>
              세션 대화 {(usage?.session.total_tokens ?? 0).toLocaleString()} ·
              음성 {(usage?.tts_session?.total_tokens ?? 0).toLocaleString()}{" "}
              토큰 · {formatEstimatedCost(usage?.session, usage?.tts_session)}
            </span>
            {!!(
              (usage?.session.unreported_requests ?? 0) +
              (usage?.tts_session?.unreported_requests ?? 0)
            ) && <span>일부 중단 요청 미집계</span>}
            {!usage && previousUsage && (
              <span>
                이전 세션: 대화{" "}
                {previousUsage.session.total_tokens.toLocaleString()} · 음성{" "}
                {(
                  previousUsage.tts_session?.total_tokens ?? 0
                ).toLocaleString()}{" "}
                ·{" "}
                {formatEstimatedCost(
                  previousUsage.session,
                  previousUsage.tts_session,
                )}
              </span>
            )}
          </div>
          {error && (
            <div className="agent-chat-error" role="alert">
              {error}
              {pending && !busy && (
                <button onClick={() => void submit(pending)}>
                  응답 다시 확인
                </button>
              )}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
