import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  CreditCard,
  LoaderCircle,
  ScanLine,
  Smartphone,
} from "lucide-react";
import { money } from "./catalog";
import { paymentMethodName, type PaymentMethod } from "./domain";

export type Payment = {
  method: PaymentMethod;
  status:
    "waiting" | "reading" | "processing" | "approved" | "failure" | "timeout";
  attempt: string;
};
export const paymentMethods = [
  { method: "card", description: "실물 카드를 리더기에 넣어 주세요", mark: "" },
  {
    method: "samsung",
    description: "휴대폰을 리더기에 대기",
    mark: "Samsung Pay",
  },
  { method: "apple", description: "iPhone · Apple Watch", mark: "Apple Pay" },
  { method: "kakao", description: "QR · 바코드로 결제", mark: "pay" },
  { method: "naver", description: "QR · 바코드로 결제", mark: "N" },
] as const;

function ReaderIllustration({
  payment,
  total,
}: {
  payment: Payment;
  total: number;
}) {
  const qr = payment.method === "kakao" || payment.method === "naver";
  const phone = payment.method !== "card";
  const read = payment.status !== "waiting";
  return (
    <svg
      className={`reader-drawing ${phone ? "phone-reader" : "card-reader"} ${read ? "is-reading" : ""}`}
      viewBox="0 0 360 270"
      aria-hidden="true"
    >
      <ellipse cx="180" cy="249" rx="115" ry="10" fill="#e6eaf0" />
      <path d="M161 164h38l10 74h-58z" fill="#c8cfd8" />
      <rect x="130" y="233" width="100" height="12" rx="6" fill="#aeb7c4" />
      <rect x="89" y="19" width="182" height="173" rx="22" fill="#c8cfd9" />
      <rect x="89" y="14" width="182" height="170" rx="22" fill="#353e4d" />
      <rect x="101" y="27" width="158" height="113" rx="11" fill="#f7f9fc" />
      <text x="180" y="56" textAnchor="middle" fill="#788390" fontSize="12">
        결제 금액
      </text>
      <text
        x="180"
        y="83"
        textAnchor="middle"
        fill="#202c3d"
        fontSize="23"
        fontWeight="700"
      >
        {money(total)}
      </text>
      <text x="180" y="115" textAnchor="middle" fill="#4a6bed" fontSize="11">
        {read ? "결제 정보를 확인하고 있어요" : "카드 · 모바일 결제"}
      </text>
      <circle className="reader-led" cx="243" cy="156" r="3" fill="#69d9ae" />
      <rect x="124" y="158" width="112" height="7" rx="3.5" fill="#141c27" />
      {!phone ? (
        <g className="inserted-card">
          <rect
            x="137"
            y="177"
            width="86"
            height="64"
            rx="7"
            fill="#dce4f3"
            stroke="#a9b8d4"
          />
          <rect
            x="148"
            y="187"
            width="19"
            height="15"
            rx="3"
            fill="#dbc898"
            stroke="#b4a477"
          />
          <path d="M148 194h19m-10-7v15" stroke="#b4a477" />
          <path
            d="M149 218h23m5 0h18"
            stroke="#9aa9bf"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <text x="207" y="230" fontSize="8" fill="#71829a" textAnchor="end">
            CARD
          </text>
        </g>
      ) : (
        <g className={`reader-phone ${qr ? "scan-phone" : "tap-phone"}`}>
          <rect x="222" y="78" width="88" height="151" rx="15" fill="#202a39" />
          <rect x="228" y="85" width="76" height="135" rx="10" fill="#fff" />
          <rect x="252" y="85" width="28" height="6" rx="3" fill="#202a39" />
          <text
            x="266"
            y="115"
            textAnchor="middle"
            fill={payment.method === "naver" ? "#03a650" : "#26364c"}
            fontSize="10"
            fontWeight="700"
          >
            {payment.method === "kakao"
              ? "kakao pay"
              : payment.method === "naver"
                ? "N pay"
                : payment.method === "apple"
                  ? "Apple Pay"
                  : "Samsung Pay"}
          </text>
          {qr ? (
            <g>
              {Array.from({ length: 22 }, (_, i) => (
                <rect
                  key={i}
                  x={238 + i * 2.55}
                  y="136"
                  width={i % 3 === 0 ? 1.8 : 1}
                  height={i % 4 === 0 ? 38 : 31}
                  fill="#283346"
                />
              ))}
              <path
                d="M236 130v-7h8m52 7v-7h-8m-52 55v7h8m52-7v7h-8"
                fill="none"
                stroke="#4a6bed"
                strokeWidth="2"
              />
              <path
                className="scanner-beam"
                d="M235 148h62"
                stroke="#61b4ff"
                strokeWidth="2"
              />
            </g>
          ) : (
            <g>
              <rect
                x="238"
                y="132"
                width="56"
                height="37"
                rx="6"
                fill="#e9eefb"
              />
              <rect
                x="245"
                y="140"
                width="12"
                height="10"
                rx="2"
                fill="#b8c5dc"
              />
              <path
                d="M251 192q15-17 30 0m-23 3q8-10 16 0m-10 4h3"
                fill="none"
                stroke="#4a6bed"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </g>
          )}
          <rect x="252" y="211" width="28" height="3" rx="1.5" fill="#dce1e8" />
        </g>
      )}
      {phone && !qr && (
        <g
          className="contactless-waves"
          fill="none"
          stroke="#4a6bed"
          strokeWidth="3"
          strokeLinecap="round"
        >
          <path d="M195 157q8 8 0 16m7-22q14 14 0 28m7-34q20 20 0 40" />
        </g>
      )}
    </svg>
  );
}

export function PaymentPanelBody({
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
  const [remaining, setRemaining] = useState(45);
  useEffect(() => {
    setRemaining(45);
    if (payment.status !== "waiting") return;
    const until = Date.now() + 45000;
    const timer = setInterval(
      () => setRemaining(Math.max(0, Math.ceil((until - Date.now()) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [payment.attempt, payment.status]);
  const failed = payment.status === "failure" || payment.status === "timeout";
  const busy = payment.status === "reading" || payment.status === "processing";
  const approved = payment.status === "approved";
  const card = payment.method === "card";
  const qr = payment.method === "kakao" || payment.method === "naver";
  const title = approved
    ? "결제가 완료됐어요"
    : payment.status === "reading"
      ? card
        ? "카드를 읽고 있어요"
        : qr
          ? "결제코드를 읽고 있어요"
          : "휴대폰을 인식하고 있어요"
      : payment.status === "processing"
        ? "결제를 승인하고 있어요"
        : payment.status === "timeout"
          ? "결제 시간이 초과됐어요"
          : failed
            ? "결제가 승인되지 않았어요"
            : card
              ? "카드를 리더기에 넣어 주세요"
              : qr
                ? "결제코드를 보여 주세요"
                : "휴대폰을 리더기에 대 주세요";
  const message = approved
    ? card
      ? "카드를 빼 주세요. 주문을 접수하고 있어요."
      : "주문을 접수하고 있어요. 잠시만 기다려 주세요."
    : busy
      ? card
        ? "승인이 끝날 때까지 카드를 빼지 말아 주세요."
        : "승인이 끝날 때까지 잠시만 기다려 주세요."
      : failed
        ? "결제되지 않았어요. 담은 메뉴는 그대로 유지돼요."
        : card
          ? "IC칩이 위로 향하도록 아래 투입구에 끝까지 넣어 주세요."
          : qr
            ? `${paymentMethodName(payment.method)} 앱의 결제코드를 아래 스캐너에 보여 주세요.`
            : `${paymentMethodName(payment.method)}를 실행한 뒤 휴대폰 뒷면을 가까이 대 주세요.`;
  const step = approved ? 2 : payment.status === "processing" ? 1 : 0;
  return (
    <div className={`payment-flow state-${payment.status}`}>
      <ol className="payment-steps" aria-label="결제 진행 단계">
        {[
          card ? "카드 인식" : qr ? "코드 인식" : "휴대폰 인식",
          "결제 승인",
          "완료",
        ].map((label, i) => (
          <li
            key={label}
            aria-current={step === i ? "step" : undefined}
            className={i <= step ? "active" : ""}
          >
            <span>{i < step || approved ? <Check size={13} /> : i + 1}</span>
            {label}
            {i < 2 && <ChevronRight size={15} />}
          </li>
        ))}
      </ol>
      <div className="payment-status-copy" role="status" aria-live="polite">
        <h2>{title}</h2>
        <p>{message}</p>
      </div>
      <div className="payment-device-area">
        {failed ? (
          <div className="payment-result-icon failure">
            {payment.status === "timeout" ? (
              <Clock3 size={54} />
            ) : (
              <CircleAlert size={54} />
            )}
          </div>
        ) : approved ? (
          <div className="payment-result-icon approved">
            <Check size={65} strokeWidth={2.4} />
          </div>
        ) : (
          <button
            className="reader-device"
            aria-label="결제 리더기"
            disabled={payment.status !== "waiting"}
            onClick={onStart}
          >
            <ReaderIllustration payment={payment} total={total} />
          </button>
        )}
      </div>
      <div className={`reader-state ${busy ? "is-busy" : ""}`}>
        {approved ? (
          <Check size={19} />
        ) : busy ? (
          <LoaderCircle className="reader-spinner" size={19} />
        ) : failed ? (
          <CircleAlert size={18} />
        ) : qr ? (
          <ScanLine size={19} />
        ) : card ? (
          <CreditCard size={19} />
        ) : (
          <Smartphone size={19} />
        )}
        <span>
          {approved
            ? "승인 완료"
            : payment.status === "reading"
              ? "결제 정보 확인 중"
              : payment.status === "processing"
                ? "승인 응답을 기다리고 있어요"
                : failed
                  ? "다시 시도하거나 결제수단을 변경해 주세요"
                  : "리더기 입력 대기"}
        </span>
        {payment.status === "waiting" && <b>{remaining}초</b>}
      </div>
      <div className="payment-amount-row">
        <span>결제 금액</span>
        <strong>{money(total)}</strong>
      </div>
      <div className="payment-flow-actions">
        {failed && (
          <button className="primary full" onClick={onRetry}>
            다시 시도하기
          </button>
        )}
        {!approved && (
          <button className="secondary full" onClick={onCancel}>
            {busy ? "결제 취소" : "다른 결제수단 선택"}
          </button>
        )}
        {approved && <p>잠시 후 주문번호를 안내해 드릴게요.</p>}
      </div>
    </div>
  );
}
