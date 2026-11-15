import { useState } from "react";
import { ArrowDownToLine, Link2, Loader2, X } from "lucide-react";
import { api } from "./api";

type Result = { status?: string; title?: string; paper_id?: string; source?: string; error?: string };

/** Import a paper straight from an arXiv ID / URL or a DOI. */
export default function IdentifierImport({ onClose, onImported }: { onClose: () => void; onImported: (message: string) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const submit = async () => {
    const value = input.trim();
    if (!value) { setError("请输入 arXiv ID / 链接，或 DOI"); return; }
    setBusy(true); setError(""); setResult(null);
    try {
      const response = (await api.importIdentifier(value)) as Result & { status?: string };
      setResult(response);
      if (response?.status === "imported") onImported(`已导入：${response.title || value}`);
      else if (response?.status === "duplicate") onImported(`已存在这篇论文：${response.title || value}`);
      else if (response?.status === "error") setError(response.error || "导入失败");
      else if (response?.error) setError(response.error);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <form className="modal identifier-import" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <header className="modal-head">
        <div><h2>通过 DOI / arXiv 导入</h2><p className="muted small">自动下载开放 PDF 并补全标题、作者、年份、期刊与摘要。</p></div>
        <button type="button" className="icon-btn" aria-label="关闭标识符导入" onClick={onClose}><X size={18} /></button>
      </header>
      <label className="field">arXiv ID、arXiv 链接或 DOI
        <input aria-label="DOI 或 arXiv ID" autoFocus value={input} placeholder="例如 2409.19256 / https://arxiv.org/abs/2409.19256 / 10.1145/3600006.3613139" onChange={(event) => setInput(event.target.value)} disabled={busy} />
      </label>
      <div className="identifier-examples">
        <Link2 size={13} /><span>支持 arXiv v1/v2、doi.org 链接；需要网络连接。</span>
      </div>
      {error && <p className="error-box" role="alert">{error}</p>}
      {result && result.status === "imported" && <p className="report-box" role="status">已导入《{result.title || "论文"}》{result.source ? `（${result.source} 元数据）` : ""}。</p>}
      {result && result.status === "duplicate" && <p className="report-box" role="status">论文库中已存在《{result.title || "这篇论文"}》，已跳过。</p>}
      {busy && <p className="muted small" role="status"><Loader2 className="spin" size={13} /> 正在解析标识符、下载 PDF 并入库…</p>}
      <div className="modal-actions">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>关闭</button>
        <button className="btn primary" disabled={busy || !input.trim()}><ArrowDownToLine size={15} />{busy ? "导入中…" : "开始导入"}</button>
      </div>
    </form>
  </div>;
}
