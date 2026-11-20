import { useEffect, useRef, useState } from "react";
import {
  MessageCircle,
  Send,
  X,
  RotateCcw,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { assetUrl } from "./catalog";
import type { CartLine, Place } from "./domain";
import "./agent-chat.css";
import { AgentSpeech } from "./agentSpeech";
import { streamAgentAudio, unlockAgentAudio } from "./agentAudio";

export type ChatCart = {
  lines: CartLine[];
  place: Place | null;
  screen: "home" | "menu" | "cart" | "payment";
};
export type AgentState = {
  phase: "ordering" | "checkout" | "handoff";
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
type Message = { role: "assistant" | "user"; text: string; id?: string };
type Pending = {
  request_id: string;
  text: string;
  cart: ChatCart;
  session: string;
};
type Result = {
  ok: boolean;
  text?: string;
  error?: string;
  state?: AgentState;
};
type StreamEvent = Result & {
  type: "text.delta" | "final" | "error" | "interrupted";
  sequence: number;
  needs_delivery?: boolean;
};
const greeting: Message = {
  role: "assistant",
  text: "안녕하세요. 원하시는 메뉴를 말씀해 주세요. 담긴 주문도 함께 확인하며 도와드릴게요.",
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
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "에이전트 서버에 연결하지 못했어요.");
  return data as T;
}

export function AgentChat({
  cart,
  disabled,
  onState,
  onOpenChange,
}: {
  cart: ChatCart;
  disabled: boolean;
  onState: (state: AgentState) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const current = useRef(cart);
  current.current = cart;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([greeting]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const speech = useRef<AgentSpeech | null>(null);
  if (!speech.current)
    speech.current = new AgentSpeech(setSpeaking, () =>
      setError(
        "음성 재생에 실패했어요. ‘음성 끄기’를 누르면 화면의 안내로 계속할 수 있어요.",
      ),
    );
  const generation = useRef(0);
  const streamAbort = useRef<AbortController | null>(null);
  const cursor = useRef(0);
  const delivery = useRef<{ session: string; request: string } | null>(null);

  useEffect(
    () => () => {
      streamAbort.current?.abort();
      speech.current?.stop();
    },
    [],
  );

  async function connect() {
    setChecking(true);
    setError("");
    try {
      setStatus(await request<Status>("status"));
    } catch {
      setStatus(null);
      setError(
        "에이전트 서버가 꺼져 있어요. order-agent에서 .venv/bin/python -m switch_agent.web을 실행한 뒤 다시 연결해 주세요.",
      );
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      void connect();
      input.current?.focus();
    } else dialog.current?.close();
    onOpenChange(open);
  }, [open]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages, busy, error]);

  function close() {
    if (!sending.current) {
      if (speaking) void interrupt();
      setOpen(false);
    }
  }

  function apply(state: AgentState) {
    onState(state);
    current.current = {
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
          : state.place
            ? current.current.screen === "cart"
              ? "cart"
              : "menu"
            : "home",
    };
  }

  async function acknowledge() {
    const target = delivery.current;
    if (!target || !status) return;
    delivery.current = null;
    try {
      await request(`sessions/${target.session}/delivered`, status.token, {
        request_id: target.request,
      });
    } catch {
      setError(
        "최종 안내 전달을 확인하지 못했어요. 결제 전에 주문을 다시 확인해 주세요.",
      );
    }
  }

  async function interrupt() {
    generation.current++;
    speech.current!.stop();
    delivery.current = null;
    streamAbort.current?.abort();
    if (session && status) {
      const result = await request<Result>(
        `sessions/${session}/interrupt`,
        status.token,
        {},
      );
      if (result.state) apply(result.state);
    }
    sending.current = false;
    setBusy(false);
    setPending(null);
  }

  async function submit(retry?: Pending) {
    if (ttsEnabled) unlockAgentAudio();
    if (!status?.ready || (!retry && !text.trim())) return;
    if (sending.current || speaking || delivery.current) {
      try {
        await interrupt();
      } catch {
        setError("주문 상태를 확인하지 못했어요. 다시 연결해 주세요.");
        return;
      }
    } else if (pending && !retry) return;
    sending.current = true;
    const turnGeneration = generation.current;
    setBusy(true);
    setError("");
    let operation = retry;
    try {
      let id = retry?.session ?? session;
      if (!id) {
        id = (
          await request<{ session_id: string }>("sessions", status.token, {})
        ).session_id;
        setSession(id);
      }
      if (generation.current !== turnGeneration) return;
      if (!operation) {
        operation = {
          request_id: crypto.randomUUID(),
          text: text.trim(),
          cart: structuredClone(current.current),
          session: id,
        };
        setMessages((previous) => [
          ...previous,
          { role: "user", text: operation!.text },
        ]);
        setText("");
        cursor.current = 0;
        speech.current!.begin();
      }
      const audioSession = id;
      const audioRequest = operation.request_id;
      speech.current!.configure((text, signal) =>
        streamAgentAudio(
          assetUrl(`agent-api/sessions/${audioSession}/speech`),
          status.token,
          { request_id: audioRequest, text },
          signal,
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
        },
      );
      if (!started.ok) {
        setPending(null);
        throw new Error(started.error);
      }
      if (generation.current !== turnGeneration) {
        await request(`sessions/${id}/interrupt`, status.token, {});
        return;
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
            });
          else
            next[index] = {
              ...next[index],
              text: append ? next[index].text + value : value,
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
            if (event.state) {
              if (
                JSON.stringify(current.current) !==
                JSON.stringify(operation.cart)
              ) {
                setSession(null);
                throw new Error(
                  "키오스크 주문이 바뀌었어요. 현재 주문으로 새 대화를 시작해 주세요.",
                );
              }
              apply(event.state);
            }
            if (event.type === "final" && event.text) {
              setAssistant(event.text, false);
              if (event.needs_delivery)
                delivery.current = {
                  session: id,
                  request: operation.request_id,
                };
              speech.current!.finish(event.text, () => void acknowledge());
            } else {
              speech.current!.stop();
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
      if (cause instanceof Error && cause.name === "AbortError") return;
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
      input.current?.focus();
    }
  }

  return (
    <>
      <button
        className="agent-chat-launcher"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <MessageCircle size={21} /> 주문 대화 테스트
      </button>
      <dialog
        ref={dialog}
        className="agent-chat-dialog"
        aria-labelledby="agent-chat-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
      >
        <div className="agent-chat-header">
          <div>
            <span className="agent-chat-eyebrow">
              SWitch · 텍스트 주문 테스트
            </span>
            <h2 id="agent-chat-title">점원에게 말하듯 주문하세요</h2>
          </div>
          <button
            className="agent-chat-icon"
            aria-label="대화 닫기"
            disabled={busy}
            onClick={close}
          >
            <X size={22} />
          </button>
        </div>
        <div className="agent-chat-connection">
          <span>
            {checking
              ? "연결 확인 중…"
              : status?.ready
                ? status.message
                : "에이전트 연결 준비 중"}
          </span>
          <button disabled={checking || busy} onClick={() => void connect()}>
            다시 연결
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
              void interrupt().catch(() =>
                setError("중단 상태를 확인하지 못했어요. 다시 연결해 주세요."),
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
        {status && !status.ready && (
          <div className="agent-chat-setup" role="status">
            {status.message}
            <br />
            설정 후 에이전트 서버를 다시 실행하고 ‘다시 연결’을 눌러 주세요.
          </div>
        )}
        <div
          className="agent-chat-log"
          role="log"
          aria-label="주문 대화"
          aria-live="polite"
          aria-relevant="additions"
        >
          {messages.map((message, index) => (
            <div key={index} className={`agent-chat-message ${message.role}`}>
              <span>{message.role === "user" ? "나" : "SWitch 점원"}</span>
              <p>{message.text}</p>
            </div>
          ))}
          {busy && (
            <p className="agent-chat-thinking" role="status">
              주문을 확인하고 있어요…
            </p>
          )}
          <div ref={end} />
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
        <div className="agent-chat-cart">
          <span>
            현재 주문 {cart.lines.reduce((sum, line) => sum + line.quantity, 0)}
            개
          </span>
          <span>대화로 변경한 주문은 키오스크에도 반영돼요.</span>
        </div>
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
            placeholder="예: 따뜻한 라떼 한 잔 포장해 주세요"
            value={text}
            maxLength={4000}
            rows={2}
            disabled={(!busy && !!pending) || !status?.ready}
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
            disabled={(!busy && !!pending) || !status?.ready || !text.trim()}
          >
            <Send size={21} />
          </button>
        </form>
        <div className="agent-chat-footer">
          <span>OpenAI AI 음성 · Enter 전송</span>
          <button
            disabled={busy || !!pending}
            onClick={() => {
              speech.current!.stop();
              delivery.current = null;
              setMessages([greeting]);
              setSession(null);
              setError("");
              setText("");
            }}
          >
            <RotateCcw size={14} /> 새 대화
          </button>
        </div>
      </dialog>
    </>
  );
}
