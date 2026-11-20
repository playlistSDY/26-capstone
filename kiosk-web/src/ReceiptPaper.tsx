import { forwardRef } from "react";
import { money } from "./catalog";
import {
  receiptDate,
  type ReceiptDocument,
  type ReceiptVariant,
} from "./receiptModel";
import "./receipt-paper.css";

export const ReceiptPaper = forwardRef<
  HTMLDivElement,
  { document: ReceiptDocument; variant: ReceiptVariant }
>(function ReceiptPaper({ document: r, variant }, ref) {
  return (
    <article
      ref={ref}
      className={`thermal-receipt ${variant === "pickup" ? "thermal-pickup" : ""}`}
      aria-label={
        variant === "pickup" ? "픽업 주문서 시안" : "상세 영수증 시안"
      }
    >
      <header className="thermal-brand">
        <strong>SWitch</strong>
        <span>COFFEE</span>
        <p>좋은 하루의 시작, 좋은 커피 한 잔.</p>
      </header>
      <div className="thermal-separator" />
      <div className="thermal-title">
        {variant === "pickup" ? "픽업 주문서" : "주문 영수증"}
      </div>
      <div className="thermal-pickup-number">
        <span>주문번호</span>
        <strong>{r.number}</strong>
        <b>{r.place} 주문</b>
      </div>
      <div className="thermal-meta">
        <span>{receiptDate(r.createdAt)}</span>
        <span>총 {r.quantity}개</span>
      </div>
      <div className="thermal-separator" />
      <div className="thermal-table-head">
        <span>주문 메뉴 / 옵션</span>
        <span>{variant === "receipt" ? "수량 · 금액" : "수량"}</span>
      </div>
      <div className="thermal-items">
        {r.items.map((item) => (
          <div className="thermal-item" key={item.id}>
            <div className="thermal-item-name">
              <b>{item.name}</b>
              <strong>
                {variant === "pickup"
                  ? `${item.quantity}개`
                  : item.amount === null
                    ? "정보 없음"
                    : money(item.amount)}
              </strong>
            </div>
            <p>{item.optionsLabel}</p>
            {variant === "receipt" && (
              <div className="thermal-unit">
                <span>
                  {item.unitPrice === null
                    ? "단가 정보 없음"
                    : money(item.unitPrice)}{" "}
                  × {item.quantity}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="thermal-separator" />
      <div className="thermal-grand-total">
        <span>{variant === "pickup" ? "총 주문" : "합계 금액"}</span>
        <strong>
          {variant === "pickup" ? `${r.quantity}개` : money(r.total)}
        </strong>
      </div>
      {variant === "receipt" && (
        <div className="thermal-payment">
          <div>
            <span>결제수단</span>
            <b>{r.method}</b>
          </div>
          <div>
            <span>결제상태</span>
            <b>승인 완료</b>
          </div>
        </div>
      )}
      <div className="thermal-separator" />
      <div className="thermal-thanks">
        <b>
          {variant === "pickup"
            ? "옵션을 확인하고 준비해 주세요."
            : "맛있게 준비해 드릴게요."}
        </b>
        <p>
          {variant === "pickup"
            ? "준비가 끝나면 주문번호로 불러 주세요."
            : "주문번호가 불리면 픽업대에서 받아 주세요."}
        </p>
      </div>
      <footer className="thermal-footer">
        <span>주문 ID {r.id.replaceAll("-", "").slice(-12).toUpperCase()}</span>
        {r.legacy && <p>이전 주문은 현재 메뉴 정보로 표시됩니다.</p>}
      </footer>
    </article>
  );
});
