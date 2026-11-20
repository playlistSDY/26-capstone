import { useRef, useState } from "react";
import {
  Check,
  Printer,
  FileText,
  Info,
  LoaderCircle,
  CheckCircle2,
} from "lucide-react";
import type { Order } from "./domain";
import { assetUrl } from "./catalog";
import {
  receiptDocument,
  RECEIPT_PROFILE,
  type PrintRequest,
  type ReceiptVariant,
} from "./receiptModel";
import { ReceiptPaper } from "./ReceiptPaper";
import { printReceipt } from "./printReceipt";
import { playSound } from "./sounds";
import type { PrinterSettings } from "./localBackend";
import "./receipt-ui.css";

export function ReceiptPreview({
  order,
  sample = false,
  onClose,
  onSettings,
  soundSettings,
}: {
  order: Order;
  sample?: boolean;
  onClose: () => void;
  onSettings: () => void;
  soundSettings: PrinterSettings;
}) {
  const [variant, setVariant] = useState<ReceiptVariant>("receipt");
  const [job, setJob] = useState<PrintRequest | null>(null);
  const [error, setError] = useState("");
  const [guide, setGuide] = useState(false);
  const paper = useRef<HTMLDivElement>(null),
    printing = useRef(false);
  const document = receiptDocument(order);
  const busy = job?.state === "preparing" || job?.state === "submitting";
  async function print() {
    if (!paper.current || printing.current) return;
    printing.current = true;
    setError("");
    try {
      await printReceipt(document, variant, (request) => {
        setJob(request);
        if (["queued", "file-saved", "error"].includes(request.state))
          printing.current = false;
      });
      playSound("print", soundSettings);
    } catch (e) {
      printing.current = false;
      setError((e as Error).message);
      playSound("error", soundSettings);
    }
  }
  return (
    <section className="receipt-workspace">
      <div className="receipt-toolbar">
        <div>
          <span className="receipt-status-dot" />
          80mm 감열지<span>·</span>EPSON TM-m30<span>·</span>USB
        </div>
        <button onClick={onSettings} disabled={busy}>
          <Printer size={16} />
          프린터 설정
        </button>
        <button onClick={() => setGuide(!guide)} aria-expanded={guide}>
          <Info size={16} />
          출력 안내
        </button>
      </div>
      <div className="receipt-variants" aria-label="영수증 시안 선택">
        <button
          className={variant === "receipt" ? "active" : ""}
          aria-pressed={variant === "receipt"}
          disabled={busy}
          onClick={() => setVariant("receipt")}
        >
          <FileText size={20} />
          <span>
            상세 영수증<small>메뉴·금액·결제 내역</small>
          </span>
          {variant === "receipt" && <Check size={18} />}
        </button>
        <button
          className={variant === "pickup" ? "active" : ""}
          aria-pressed={variant === "pickup"}
          disabled={busy}
          onClick={() => setVariant("pickup")}
        >
          <CheckCircle2 size={20} />
          <span>
            픽업 주문서<small>큰 주문번호·제조 옵션</small>
          </span>
          {variant === "pickup" && <Check size={18} />}
        </button>
      </div>
      {sample && (
        <p className="receipt-sample-note">
          디자인 확인용 예시 주문이에요. 실제 주문 내역에는 저장되지 않아요.
          <a
            href={assetUrl(`assets/receipts/sample-${variant}-80mm.pdf`)}
            download={`SWitch_${variant === "receipt" ? "영수증" : "픽업주문서"}_80mm_시안.pdf`}
          >
            시안 PDF 다운로드
          </a>
        </p>
      )}
      {guide && (
        <div className="receipt-print-guide">
          <b>TM-m30 · 80mm USB 출력 설정</b>
          <p>
            프린터 설정에서 출력 대상을 선택해 주세요. 로컬 백엔드가 한글 영수증
            이미지를 만들고 Windows 인쇄 대기열로 전송해요. 자동 절단은 Epson
            드라이버의 문서 종료 절단 설정을 사용해요.
          </p>
          <p>
            시안 PDF는 미리보기의 다운로드 링크로 받을 수 있어요. 대기열 전송은
            종이 출력 완료를 의미하지 않아요.
          </p>
        </div>
      )}
      <div className="receipt-preview-surface">
        <div className="receipt-paper-ruler">
          <span>80 mm</span>
          <i />
        </div>
        <div className="receipt-paper-holder">
          <ReceiptPaper ref={paper} document={document} variant={variant} />
        </div>
        <p className="receipt-paper-caption">
          인쇄 영역 {RECEIPT_PROFILE.printableWidthMm}mm · 흑백 출력
        </p>
      </div>
      <div className="receipt-print-actions">
        {error ? (
          <p className="receipt-print-error" role="alert">
            {error}
          </p>
        ) : (
          job && (
            <p className="receipt-print-status" role="status">
              {job.state === "preparing"
                ? "영수증을 인쇄 크기로 준비하고 있어요."
                : job.state === "submitting"
                  ? "로컬 백엔드에서 출력하고 있어요."
                  : job.state === "file-saved"
                    ? "개발용 PNG 파일을 저장했어요. 종이는 출력하지 않았어요."
                    : "Windows 인쇄 대기열로 전송했어요. 출력물을 확인해 주세요."}
            </p>
          )
        )}
        <div>
          <button className="secondary" disabled={busy} onClick={onClose}>
            확인
          </button>
          <button className="primary" disabled={busy} onClick={print}>
            {busy ? (
              <LoaderCircle className="receipt-print-spinner" size={22} />
            ) : (
              <Printer size={22} />
            )}
            영수증 출력
          </button>
        </div>
      </div>
    </section>
  );
}
