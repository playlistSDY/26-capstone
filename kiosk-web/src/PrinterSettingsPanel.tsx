import { uiText } from "./i18n";
import { useEffect, useState } from "react";
import { Download, Printer, Check, RefreshCw, Volume2 } from "lucide-react";
import {
  receiptDocument,
  sampleReceiptOrder,
  type PrintRequest,
} from "./receiptModel";
import { printReceipt } from "./printReceipt";
import { assetUrl } from "./catalog";
import {
  backendRequest,
  loadBackend,
  saveBackendSettings,
  type LocalPrinter,
  type PrinterSettings,
} from "./localBackend";
import { playSound, soundChoices } from "./sounds";
import "./printer-settings.css";

export function PrinterSettingsPanel({
  value,
  onSave,
  onClose,
}: {
  value: PrinterSettings;
  onSave: (value: PrinterSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value),
    [printers, setPrinters] = useState<LocalPrinter[]>([]);
  const [online, setOnline] = useState(false),
    [fileMode, setFileMode] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  const [jobs, setJobs] = useState<
    Array<{ id: string; state: string; number: string; message?: string }>
  >([]);
  function patch(change: Partial<PrinterSettings>) {
    setDraft((v) => ({ ...v, ...change }));
  }
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const status = await loadBackend();
      setDraft(status.settings);
      setOnline(true);
      setFileMode(status.fileMode);
      const [list, history] = await Promise.all([
        backendRequest<{ printers: LocalPrinter[] }>("printers"),
        backendRequest<{ jobs: typeof jobs }>("jobs"),
      ]);
      setPrinters(list.printers);
      setJobs(history.jobs);
    } catch (e) {
      setOnline(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function save() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const saved = await saveBackendSettings(draft);
      onSave(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function testPrint() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const saved = await saveBackendSettings(draft);
      setDraft(saved);
      const job = await printReceipt(
        receiptDocument(sampleReceiptOrder()),
        draft.variant,
        () => {},
        "test",
      );
      setNote(
        job.state === "file-saved"
          ? "개발용 PNG 파일을 저장했어요. 종이는 출력하지 않았어요."
          : "Windows 인쇄 대기열에 전송했어요. 출력물을 확인해 주세요.",
      );
      setJobs((await backendRequest<{ jobs: typeof jobs }>("jobs")).jobs);
      playSound("print", draft);
    } catch (e) {
      setError((e as Error).message);
      playSound("error", draft);
    } finally {
      setBusy(false);
    }
  }
  const states: Record<string, string> = {
    queued: "대기열 전송",
    processing: "처리 중",
    "file-saved": "PNG 저장",
    error: "오류",
    uncertain: "상태 확인 필요",
  };
  return (
    <section className="printer-settings-panel">
      <div className="printer-settings-scroll">
        <div className="printer-device-card">
          <Printer size={30} />
          <div>
            <b>{uiText("기기 설정")}</b>
            <p>
              {uiText(
                online
                  ? fileMode
                    ? "개발용 파일 출력 모드"
                    : "로컬 백엔드 연결됨 · USB 프린터"
                  : "로컬 백엔드 연결 확인",
              )}
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={busy}
            aria-label={uiText("프린터 목록 새로고침")}
          >
            <RefreshCw size={19} />
          </button>
        </div>
        {uiText(
          !online && (
            <div className="printer-section printer-windows-guide">
              <h3>{uiText("Windows 로컬 실행")}</h3>
              <p>
                {uiText(
                  "ZIP 파일을 모두 풀고 실행.bat을 열어 주세요. 브라우저·백엔드·이미지·글꼴이 포함되어 있어 인터넷 없이 사용할 수 있어요.",
                )}
              </p>
              <a
                className="printer-outline"
                href={assetUrl("downloads/SWitch-Windows-Offline.zip")}
                download
              >
                <Download size={18} />
                {uiText("Windows 오프라인 패키지 받기")}
              </a>
            </div>
          ),
        )}
        <div className="printer-section">
          <h3>{uiText("영수증 프린터")}</h3>
          <div className="printer-field">
            <label htmlFor="printer-name">{uiText("출력 대상")}</label>
            <select
              id="printer-name"
              disabled={!online || busy}
              value={draft.printerName}
              onChange={(e) => patch({ printerName: e.target.value })}
            >
              <option value="">{uiText("프린터를 선택해 주세요")}</option>
              {uiText(
                printers.map((p) => (
                  <option key={p.name} value={p.name} disabled={p.virtual}>
                    {uiText(p.name)}
                    {uiText(p.offline ? " · 오프라인" : "")}
                    {uiText(p.virtual ? " · 가상 프린터" : "")}
                  </option>
                )),
              )}
            </select>
          </div>
          {uiText(
            online && !printers.length && (
              <p>
                {uiText(
                  "Windows에 등록된 프린터가 없어요. Epson 드라이버를 설치하고 USB 연결을 확인해 주세요.",
                )}
              </p>
            ),
          )}
          <small>
            {uiText(
              "80mm 감열지 · 인쇄 영역 72mm. Chrome 인쇄 창 없이 선택한 프린터로 전송해요. 자동 절단은 Epson 드라이버의 문서 종료 절단 설정을 사용해요.",
            )}
          </small>
          <label className="printer-check printer-auto-toggle">
            <input
              type="checkbox"
              checked={draft.autoPrint}
              onChange={(e) => patch({ autoPrint: e.target.checked })}
            />
            <span>
              <b>{uiText("결제 완료 후 영수증 자동 출력")}</b>
              <small>{uiText("완료된 새 주문을 1회 출력 요청해요.")}</small>
            </span>
          </label>
          <div className="printer-field">
            <label htmlFor="receipt-variant">{uiText("영수증 종류")}</label>
            <select
              id="receipt-variant"
              value={draft.variant}
              onChange={(e) =>
                patch({ variant: e.target.value as PrinterSettings["variant"] })
              }
            >
              <option value="receipt">
                {uiText("상세 영수증 · 메뉴·금액")}
              </option>
              <option value="pickup">
                {uiText("픽업 주문서 · 주문번호·옵션")}
              </option>
            </select>
          </div>
          <div className="printer-field">
            <label htmlFor="font-scale">{uiText("글자 크기")}</label>
            <select
              id="font-scale"
              value={draft.fontScale}
              onChange={(e) => patch({ fontScale: Number(e.target.value) })}
            >
              <option value={1}>{uiText("기본")}</option>
              <option value={1.15}>{uiText("크게")}</option>
              <option value={1.3}>{uiText("아주 크게")}</option>
            </select>
          </div>
          <div className="printer-field">
            <label htmlFor="printer-offset">{uiText("좌우 보정")}</label>
            <input
              id="printer-offset"
              type="number"
              min="-3"
              max="3"
              step="0.5"
              value={draft.offsetXmm}
              onChange={(e) => patch({ offsetXmm: Number(e.target.value) })}
            />
            <span>mm</span>
          </div>
          <button
            className="printer-outline"
            disabled={!online || busy || !draft.printerName}
            onClick={testPrint}
          >
            <Printer size={18} />
            {uiText(busy ? "처리 중…" : "설정 적용 · 테스트 출력")}
          </button>
        </div>
        <div className="printer-section printer-windows-guide">
          <h3>
            <Volume2 size={20} />
            {uiText("효과음")}
          </h3>
          <label className="printer-check">
            <input
              type="checkbox"
              checked={draft.soundEnabled}
              onChange={(e) => patch({ soundEnabled: e.target.checked })}
            />
            <span>{uiText("터치·주문·결제 효과음 사용")}</span>
          </label>
          <div className="printer-field">
            <label htmlFor="sound-volume">
              {uiText("볼륨 ")}
              {uiText(draft.soundVolume)}%
            </label>
            <input
              id="sound-volume"
              type="range"
              min="0"
              max="100"
              value={draft.soundVolume}
              onChange={(e) => patch({ soundVolume: Number(e.target.value) })}
            />
          </div>
          <div className="sound-preview-grid">
            {uiText(
              soundChoices.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className="printer-outline compact"
                  data-sound-preview
                  aria-label={uiText(`${label} 소리 듣기`)}
                  onClick={() => playSound(id, draft, true)}
                >
                  {uiText(label)}
                </button>
              )),
            )}
          </div>
        </div>
        {uiText(
          jobs.length > 0 && (
            <div className="printer-section printer-windows-guide">
              <h3>{uiText("최근 출력 요청")}</h3>
              <div className="printer-jobs">
                {uiText(
                  jobs.slice(0, 5).map((j) => (
                    <div key={j.id}>
                      <b>
                        {uiText("주문 ")}
                        {uiText(j.number)}
                      </b>
                      <span>{uiText(states[j.state] || j.state)}</span>
                      {uiText(j.message && <small>{uiText(j.message)}</small>)}
                    </div>
                  )),
                )}
              </div>
              <small>
                {uiText(
                  "대기열 전송은 종이 출력 완료를 의미하지 않아요. 오류·상태 불명은 대기열 확인 후 수동 재출력해 주세요.",
                )}
              </small>
            </div>
          ),
        )}
        {uiText(
          note && (
            <p className="printer-test-status" role="status">
              {uiText(note)}
            </p>
          ),
        )}
        {uiText(
          error && (
            <p className="printer-error" role="alert">
              {uiText(error)}
            </p>
          ),
        )}
        <small className="printer-shortcut">
          {uiText("관리자 설정 열기: Ctrl + Alt + S")}
        </small>
      </div>
      <div className="printer-settings-actions">
        <button className="secondary" onClick={onClose} disabled={busy}>
          {uiText("닫기")}
        </button>
        <button className="primary" disabled={!online || busy} onClick={save}>
          <Check size={21} />
          {uiText("설정 저장")}
        </button>
      </div>
    </section>
  );
}
