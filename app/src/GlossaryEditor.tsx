import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, Plus, Trash2, Upload, Wand2 } from "lucide-react";
import { api, type GlossaryTerm } from "./api";
import "./glossary.css";

/** A single editable glossary row (all fields are strings so inputs stay controlled). */
export type GlossaryRow = { source: string; target: string; domain: string; enabled: boolean };

/**
 * Small curated AI / CS terminology preset (FEAT-UX-03). These are the terms the
 * spec calls out as frequently mistranslated by generic MT engines.
 */
export const AI_CS_PRESET_TERMS: GlossaryTerm[] = [
  { source: "Attention", target: "注意力机制", domain: "AI/CS" },
  { source: "Rollout", target: "轨迹采样", domain: "AI/CS" },
  { source: "Head", target: "注意力头", domain: "AI/CS" },
  { source: "Register", target: "寄存器", domain: "AI/CS" },
  { source: "Alignment", target: "对齐", domain: "AI/CS" },
  { source: "Token", target: "词元", domain: "AI/CS" },
  { source: "Embedding", target: "嵌入", domain: "AI/CS" },
  { source: "Quantization", target: "量化", domain: "AI/CS" },
  { source: "Distillation", target: "蒸馏", domain: "AI/CS" },
  { source: "Fine-tuning", target: "微调", domain: "AI/CS" },
];

/** Split one CSV line into cells, respecting double-quoted cells (incl. `""` escapes). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
    } else if (char === '"' && cell.trim() === "") {
      // Only a quote at the start of a cell opens a quoted section.
      quoted = true;
      cell = "";
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/** One cell as CSV: quote when it contains a delimiter, quote or newline. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Trim, validate and deduplicate terms. Rows need a non-empty source *and* target;
 * the first occurrence of a source wins (case-insensitive) so two mappings for the
 * same English term never reach the backend.
 */
export function normalizeGlossaryTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
  const seen = new Set<string>();
  const result: GlossaryTerm[] = [];
  for (const term of terms) {
    const source = (term.source ?? "").trim();
    const target = (term.target ?? "").trim();
    if (!source || !target) continue;
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const domain = (term.domain ?? "").trim();
    result.push({ source, target, ...(domain ? { domain } : {}), enabled: term.enabled !== false });
  }
  return result;
}

/**
 * Parse client-side CSV (`source,target[,domain]`). A leading `source,target`
 * header row is skipped, blank/malformed lines are ignored, quoted commas are
 * supported and the result is normalized/deduplicated.
 */
export function parseGlossaryCsv(text: string): GlossaryTerm[] {
  const terms: GlossaryTerm[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const source = cells[0] ?? "";
    const target = cells[1] ?? "";
    if (!source && !target) continue;
    if (/^(?:source|原文|术语)$/i.test(source) && /^(?:target|译法|译文)$/i.test(target)) continue;
    if (!source || !target) continue;
    const domain = cells[2] ?? "";
    terms.push({ source, target, ...(domain ? { domain } : {}) });
  }
  return normalizeGlossaryTerms(terms);
}

/** Serialize terms to CSV (`source,target,domain`), quoting cells that need it. */
export function glossaryToCsv(terms: GlossaryTerm[]): string {
  const rows = normalizeGlossaryTerms(terms).map((term) => [csvCell(term.source), csvCell(term.target), csvCell(term.domain ?? "")].join(","));
  return ["source,target,domain", ...rows].join("\n");
}

/** Merge incoming terms into existing rows, skipping sources that already exist. */
function mergeRows(rows: GlossaryRow[], incoming: GlossaryTerm[]): { rows: GlossaryRow[]; added: number; skipped: number } {
  const existing = new Set(rows.map((row) => row.source.trim().toLowerCase()).filter(Boolean));
  const next = [...rows];
  let added = 0;
  let skipped = 0;
  for (const term of normalizeGlossaryTerms(incoming)) {
    const key = term.source.toLowerCase();
    if (existing.has(key)) { skipped += 1; continue; }
    existing.add(key);
    next.push({ source: term.source, target: term.target, domain: term.domain ?? "", enabled: term.enabled !== false });
    added += 1;
  }
  return { rows: next, added, skipped };
}

const toRows = (terms: GlossaryTerm[]): GlossaryRow[] =>
  normalizeGlossaryTerms(terms).map((term) => ({ source: term.source, target: term.target, domain: term.domain ?? "", enabled: term.enabled !== false }));

export type GlossaryEditorProps = {
  /** Start expanded (defaults to collapsed so the translation pane stays tidy). */
  defaultOpen?: boolean;
  /** Optional callback so the parent pane can show a term count / dirty state. */
  onCountChange?: (count: number) => void;
};

/**
 * FEAT-UX-03: collapsible custom glossary editor rendered under 设置 → 翻译引擎.
 * Loads via `api.glossary()`, persists via `api.saveGlossary(terms)`; CSV
 * import/export and the AI/CS preset are entirely client-side.
 */
export default function GlossaryEditor({ defaultOpen = false, onCountChange }: GlossaryEditorProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<GlossaryRow[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const loadStarted = useRef(false);

  useEffect(() => { onCountChange?.(rows.length); }, [rows.length, onCountChange]);

  const load = async () => {
    if (loadStarted.current || loaded) return;
    loadStarted.current = true;
    setLoading(true);
    setError("");
    try {
      if (typeof api.glossary !== "function") throw new Error("当前客户端不支持术语表，请升级桌面客户端");
      const result = await api.glossary();
      setRows(toRows(result?.terms ?? []));
    } catch (reason) {
      setError((reason as Error).message || "加载术语表失败");
    } finally {
      setLoaded(true);
      setLoading(false);
    }
  };

  // `defaultOpen` mounts the editor expanded, so load immediately in that case.
  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  const updateRow = (index: number, field: "source" | "target" | "domain", value: string) =>
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row)));

  const toggleRow = (index: number) =>
    setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, enabled: !row.enabled } : row)));

  const addRow = () => {
    setMessage("");
    setError("");
    setRows((current) => [...current, { source: "", target: "", domain: "", enabled: true }]);
  };

  const removeRow = (index: number) => {
    setMessage("");
    setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    const terms = normalizeGlossaryTerms(rows);
    if (!terms.length) {
      setSaving(false);
      setError("请至少填写一条「原文 → 译法」完整的术语");
      return;
    }
    try {
      const result = await api.saveGlossary(terms);
      setRows(toRows(terms));
      setMessage(`已保存 ${result?.count ?? terms.length} 条术语`);
      setLoaded(true);
    } catch (reason) {
      setError((reason as Error).message || "保存术语表失败");
    } finally {
      setSaving(false);
    }
  };

  const importPresets = () => {
    setError("");
    const merged = mergeRows(rows, AI_CS_PRESET_TERMS);
    setRows(merged.rows);
    setMessage(merged.skipped
      ? `已加入 ${merged.added} 条 AI/CS 常用预设（跳过 ${merged.skipped} 条已存在）；点击「保存术语表」生效`
      : `已加入 ${merged.added} 条 AI/CS 常用预设；点击「保存术语表」生效`);
  };

  const readFile = (file: File) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取 CSV 文件失败"));
    reader.readAsText(file);
  });

  const importCsv = async (file: File) => {
    setError("");
    setMessage("");
    try {
      const parsed = parseGlossaryCsv(await readFile(file));
      if (!parsed.length) {
        setError("CSV 中没有可用术语（格式：source,target[,domain]）");
        return;
      }
      const merged = mergeRows(rows, parsed);
      setRows(merged.rows);
      setMessage(merged.skipped
        ? `已导入 ${merged.added} 条术语（跳过 ${merged.skipped} 条重复）；点击「保存术语表」生效`
        : `已导入 ${merged.added} 条术语；点击「保存术语表」生效`);
    } catch (reason) {
      setError((reason as Error).message || "导入 CSV 失败");
    }
  };

  const exportCsv = () => {
    setError("");
    try {
      const csv = glossaryToCsv(rows);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "glossary.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage(`已导出 ${normalizeGlossaryTerms(rows).length} 条术语 CSV`);
    } catch {
      setError("当前环境不支持下载 CSV，请检查桌面客户端权限");
    }
  };

  return (
    <section className="glossary-editor" aria-label="专业术语表">
      <button className="glossary-toggle" aria-expanded={open} onClick={toggleOpen}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <span>专业术语表（Glossary）</span>
        <span className="glossary-count">{rows.length} 条</span>
      </button>
      {open && (
        <div className="glossary-body">
          <p className="small muted">
            整篇翻译、划词翻译与 AI 问答会优先按此表译法约束专业术语；CSV 格式为 <code>source,target[,domain]</code>，同一原文只保留第一条。
          </p>
          <div className="glossary-actions">
            <button className="btn" onClick={addRow}><Plus size={14} />添加术语</button>
            <button className="btn" onClick={importPresets}><Wand2 size={14} />导入 AI/CS 常用预设</button>
            <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={14} />导入 CSV</button>
            <button className="btn" onClick={exportCsv}><Download size={14} />导出 CSV</button>
            <button className="btn primary" disabled={saving || loading} onClick={() => void save()}>
              {saving ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}保存术语表
            </button>
            <input
              ref={fileRef}
              className="glossary-file"
              type="file"
              accept=".csv,text/csv"
              aria-label="导入术语 CSV 文件"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importCsv(file);
              }}
            />
          </div>
          {loading && <p className="small muted" role="status">正在加载术语表…</p>}
          {!loading && !rows.length && <p className="small muted">尚未添加术语，可手工添加、导入 CSV 或使用 AI/CS 常用预设。</p>}
          {rows.length > 0 && (
            <ul className="glossary-rows">
              <li className="glossary-row glossary-row-head" aria-hidden="true">
                <span>原文</span><span>译法</span><span>领域（可选）</span><span>启用</span><span />
              </li>
              {rows.map((row, index) => (
                <li className="glossary-row" key={index}>
                  <input aria-label={`第 ${index + 1} 条术语原文`} placeholder="Attention" value={row.source} onChange={(event) => updateRow(index, "source", event.target.value)} />
                  <input aria-label={`第 ${index + 1} 条术语译法`} placeholder="注意力机制" value={row.target} onChange={(event) => updateRow(index, "target", event.target.value)} />
                  <input aria-label={`第 ${index + 1} 条术语领域`} placeholder="AI/CS" value={row.domain} onChange={(event) => updateRow(index, "domain", event.target.value)} />
                  <label className="glossary-enabled">
                    <input type="checkbox" aria-label={`启用第 ${index + 1} 条术语`} checked={row.enabled} onChange={() => toggleRow(index)} />
                  </label>
                  <button className="btn danger tiny" aria-label={`删除第 ${index + 1} 条术语`} onClick={() => removeRow(index)}><Trash2 size={13} /></button>
                </li>
              ))}
            </ul>
          )}
          {message && <p className="report-box" role="status">{message}</p>}
          {error && <p className="error-box" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
