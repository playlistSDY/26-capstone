import { uiText } from "./i18n";
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
      aria-label={uiText(
        variant === "pickup" ? "픽업 주문서 시안" : "상세 영수증 시안",
      )}
    >
      <header className="thermal-brand">
        <strong>SWitch</strong>
        <span>COFFEE</span>
        <p>{uiText("좋은 하루의 시작, 좋은 커피 한 잔.")}</p>
      </header>
      <div className="thermal-separator" />
      <div className="thermal-title">
        {uiText(variant === "pickup" ? "픽업 주문서" : "주문 영수증")}
      </div>
      <div className="thermal-pickup-number">
        <span>{uiText("주문번호")}</span>
        <strong>{uiText(r.number)}</strong>
        <b>
          {uiText(r.place)}
          {uiText(" 주문")}
        </b>
      </div>
      <div className="thermal-meta">
        <span>{uiText(receiptDate(r.createdAt))}</span>
        <span>
          {uiText("총 ")}
          {uiText(r.quantity)}
          {uiText("개")}
        </span>
      </div>
      <div className="thermal-separator" />
      <div className="thermal-table-head">
        <span>{uiText("주문 메뉴 / 옵션")}</span>
        <span>{uiText(variant === "receipt" ? "수량 · 금액" : "수량")}</span>
      </div>
      <div className="thermal-items">
        {uiText(
          r.items.map((item) => (
            <div className="thermal-item" key={item.id}>
              <div className="thermal-item-name">
                <b>{uiText(item.name)}</b>
                <strong>
                  {uiText(
                    variant === "pickup"
                      ? `${item.quantity}개`
                      : item.amount === null
                        ? "정보 없음"
                        : money(item.amount),
                  )}
                </strong>
              </div>
              <p>{uiText(item.optionsLabel)}</p>
              {uiText(
                variant === "receipt" && (
                  <div className="thermal-unit">
                    <span>
                      {uiText(
                        item.unitPrice === null
                          ? "단가 정보 없음"
                          : money(item.unitPrice),
                      )}
                      {uiText(" ")}× {uiText(item.quantity)}
                    </span>
                  </div>
                ),
              )}
            </div>
          )),
        )}
      </div>
      <div className="thermal-separator" />
      <div className="thermal-grand-total">
        <span>{uiText(variant === "pickup" ? "총 주문" : "합계 금액")}</span>
        <strong>
          {uiText(variant === "pickup" ? `${r.quantity}개` : money(r.total))}
        </strong>
      </div>
      {uiText(
        variant === "receipt" && (
          <div className="thermal-payment">
            <div>
              <span>{uiText("결제수단")}</span>
              <b>{uiText(r.method)}</b>
            </div>
            <div>
              <span>{uiText("결제상태")}</span>
              <b>{uiText("승인 완료")}</b>
            </div>
          </div>
        ),
      )}
      <div className="thermal-separator" />
      <div className="thermal-thanks">
        <b>
          {uiText(
            variant === "pickup"
              ? "옵션을 확인하고 준비해 주세요."
              : "맛있게 준비해 드릴게요.",
          )}
        </b>
        <p>
          {uiText(
            variant === "pickup"
              ? "준비가 끝나면 주문번호로 불러 주세요."
              : "주문번호가 불리면 픽업대에서 받아 주세요.",
          )}
        </p>
      </div>
      <footer className="thermal-footer">
        <span>
          {uiText("주문 ID ")}
          {uiText(r.id.replaceAll("-", "").slice(-12).toUpperCase())}
        </span>
        {uiText(
          r.legacy && (
            <p>{uiText("이전 주문은 현재 메뉴 정보로 표시됩니다.")}</p>
          ),
        )}
      </footer>
    </article>
  );
});
