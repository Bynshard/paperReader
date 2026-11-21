import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, FileText, Link2, Loader2, Tag, Wand2, X } from "lucide-react";
import { api } from "./api";
import { folderRows } from "./folders";
import type { Category, Paper, Version } from "./types";

type Props = {
  paper: Paper | null;
  loading: boolean;
  error?: string;
  categories?: Category[];
  onClose: () => void;
  onOpen: (paper: Paper) => void;
  onSaved: (paper: Paper) => void;
  onToast: (message: string) => void;
};

const FIELDS = ["title", "authors", "year", "venue", "doi", "arxiv"] as const;
const LABELS: Record<(typeof FIELDS)[number], string> = { title: "标题", authors: "作者", year: "年份", venue: "期刊 / 会议", doi: "DOI", arxiv: "arXiv" };

function versionLabel(version: Version) {
  return version.kind === "translated" ? "译文" : "原文";
}

/** Single-click paper preview with autosaving in-place editing (no PDF reader required). */
export default function Inspector({ paper, loading, error, categories = [], onClose, onOpen, onSaved, onToast }: Props) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [tags, setTags] = useState("");
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [filling, setFilling] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"" | "saving" | "saved">("");
  const paperRef = useRef<Paper | null>(paper); paperRef.current = paper;
  const version = useRef(0);
  const inFlight = useRef(false);
  const rows = useMemo(() => folderRows(categories), [categories]);

  useEffect(() => {
    if (!paper) return;
    setFields(Object.fromEntries([...FIELDS, "short_note", "abstract", "notes", "read_status"].map((key) => [key, String((paper as unknown as Record<string, unknown>)[key] ?? "")])));
    setTags(paper.tags.map((tag) => tag.name).join(", "));
    setCategoryIds(paper.categories.map((category) => category.id));
    setSaveError("");
    setDirty(false);
    setSaveState("");
    version.current++;
    // Only reset when switching papers; autosave updates the same record.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper?.id]);

  const versions = useMemo(() => [...(paper?.versions ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.created_at - b.created_at), [paper?.versions]);

  const change = (key: string, value: string) => {
    version.current++;
    setFields((all) => ({ ...all, [key]: value }));
    setDirty(true);
    setSaveState("");
  };
  const changeTags = (value: string) => { version.current++; setTags(value); setDirty(true); setSaveState(""); };
  const toggleCategory = (id: string) => {
    version.current++;
    setCategoryIds((all) => all.includes(id) ? all.filter((value) => value !== id) : [...all, id]);
    setDirty(true);
    setSaveState("");
  };

  const persist = useCallback(async (silent = false): Promise<boolean> => {
    const current = paperRef.current;
    if (!current || inFlight.current) return false;
    inFlight.current = true;
    const snapshot = version.current;
    setBusy(true); setSaveState("saving"); setSaveError("");
    try {
      const saved = await api.savePaper({
        paper_id: current.id,
        expected_updated_at: current.updated_at,
        fields: { ...fields },
        category_ids: categoryIds,
        tags: tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean),
      });
      onSaved(saved);
      if (snapshot === version.current) { setDirty(false); setSaveState("saved"); }
      if (!silent) onToast("论文资料已保存");
      return true;
    } catch (e) {
      setSaveError((e as Error).message);
      setSaveState("");
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [fields, categoryIds, tags, onSaved, onToast]);

  useEffect(() => {
    if (!dirty || busy) return;
    const timer = setTimeout(() => { void persist(true); }, 900);
    return () => clearTimeout(timer);
  }, [fields, tags, categoryIds, dirty, busy, persist]);

  const fill = async () => {
    if (!paper) return;
    setFilling(true); setSaveError("");
    try {
      // refreshMetadata already writes to SQLite, so flush local edits first and
      // never mark the refreshed record dirty (that would trigger a second save
      // 900ms later and risk an expected_updated_at conflict).
      if (dirty && !(await persist(true))) return;
      const fresh = await api.refreshMetadata(paper.id, false);
      const keys = ["title", "authors", "year", "venue", "doi", "arxiv", "abstract"] as const;
      setFields((all) => ({ ...all, ...Object.fromEntries(keys.map((key) => [key, String((fresh as unknown as Record<string, unknown>)[key] ?? all[key] ?? "")])) }));
      version.current++;
      setDirty(false);
      setSaveState("saved");
      onSaved(fresh);
      onToast(fresh.updated_fields?.length ? `已补全：${fresh.updated_fields.join("、")}` : "字段已是最新，没有可补全内容");
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setFilling(false);
    }
  };

  const close = async () => {
    if (dirty && !(await persist(true))) return;
    onClose();
  };

  return (
    <aside className="inspector" aria-label="论文详情">
      <header className="inspector-head">
        <div>
          <div className="inspector-eyebrow">论文详情</div>
          <strong title={paper?.title}>{paper?.title || "正在载入…"}</strong>
        </div>
        <button className="icon-btn" aria-label="关闭论文详情" onClick={() => void close()}><X size={17} /></button>
      </header>

      {loading && <div className="inspector-state"><Loader2 className="spin" size={18} />正在读取论文资料…</div>}
      {error && !loading && <div className="error-box" role="alert">读取详情失败：{error}</div>}

      {paper && !loading && (
        <div className="inspector-body">
          <div className="inspector-meta">
            <button className="btn primary small" onClick={() => onOpen(paper)}><FileText size={15} />打开阅读</button>
            <span className="reading-state-group" role="group" aria-label="阅读状态">
              {([["unread", "未读"], ["reading", "在读"], ["read", "已读"]] as const).map(([key, label]) => (
                <button key={key} className={`reading-state ${key} ${fields.read_status === key ? "on" : ""}`} aria-pressed={fields.read_status === key} onClick={() => change("read_status", key)}>{label}</button>
              ))}
            </span>
          </div>

          <section className="inspector-section">
            <div className="inspector-grid">
              {FIELDS.map((key) => (
                <label key={key} className={key === "title" || key === "authors" || key === "doi" || key === "arxiv" ? "span-2" : ""}>{LABELS[key]}
                  <input aria-label={`详情${LABELS[key]}`} value={fields[key] ?? ""} onChange={(e) => change(key, e.target.value)} />
                </label>
              ))}
            </div>
            <div className="inspector-links">
              {paper.doi && <a href={`https://doi.org/${paper.doi}`} target="_blank" rel="noopener noreferrer"><Link2 size={13} />DOI</a>}
              {paper.arxiv && <a href={`https://arxiv.org/abs/${paper.arxiv}`} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />arXiv</a>}
              <button className="link" disabled={filling} onClick={() => void fill()}><Wand2 size={12} />{filling ? "查询中…" : "自动补全资料"}</button>
              {paper.citation_count != null && <span className="muted small">被引 {paper.citation_count.toLocaleString()} 次{paper.citation_source ? ` · ${paper.citation_source}` : ""}</span>}
            </div>
          </section>

          <section className="inspector-section">
            <label>一句话速记<input aria-label="详情一句话速记" maxLength={300} value={fields.short_note ?? ""} placeholder="用一句话记住这篇论文" onChange={(e) => change("short_note", e.target.value)} /></label>
            <label>摘要<textarea aria-label="详情摘要" rows={4} value={fields.abstract ?? ""} onChange={(e) => change("abstract", e.target.value)} /></label>
            <label>笔记<textarea aria-label="详情笔记" rows={4} value={fields.notes ?? ""} onChange={(e) => change("notes", e.target.value)} /></label>
          </section>

          <section className="inspector-section">
            <div className="inspector-section-title"><Tag size={14} />分类与标签</div>
            <div className="pill-list">
              {rows.length === 0 && <span className="muted small">还没有分类</span>}
              {rows.map((row) => <label key={row.id} className={`pill ${categoryIds.includes(row.id) ? "on" : ""}`} title={row.path}>
                <input type="checkbox" checked={categoryIds.includes(row.id)} onChange={() => toggleCategory(row.id)} />
                {categoryIds.includes(row.id) && <Check size={12} />}
                <span>{row.path}</span>
              </label>)}
            </div>
            <label>标签（逗号分隔）<input aria-label="详情标签" value={tags} onChange={(e) => changeTags(e.target.value)} /></label>
          </section>

          <section className="inspector-section">
            <div className="inspector-section-title"><FileText size={14} />附件版本</div>
            {versions.length === 0 && <p className="muted small">没有可用的 PDF 附件。</p>}
            {versions.map((item) => (
              <div className="version-row" key={item.id}>
                <span className={`version-kind ${item.kind}`}>{versionLabel(item)}</span>
                <span className="small muted">{item.pages} 页 · {(item.bytes / 1024 / 1024).toFixed(1)} MB</span>
                <button className="link" onClick={() => onOpen(paper)}>阅读</button>
              </div>
            ))}
          </section>

          {saveError && <div className="error-box" role="alert">{saveError}</div>}
          <div className="inspector-actions">
            <span className="muted small" role="status">{saveState === "saving" ? "自动保存中…" : saveState === "saved" ? "已自动保存" : dirty ? "有未保存修改" : ""}</span>
            <button className="btn" onClick={() => void close()}>关闭</button>
            <button className="btn primary" disabled={busy || !dirty} onClick={() => void persist()}>{busy ? "保存中…" : "保存修改"}</button>
          </div>
        </div>
      )}
    </aside>
  );
}
