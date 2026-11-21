import { useMemo, useState } from "react";
import { Download, Sparkles, X } from "lucide-react";
import { api } from "./api";

/**
 * FEAT-AI-02: cross-paper synthesis.
 *
 * The backend exposes one RPC (`synthesis_matrix`) that aggregates per-paper
 * evidence and returns a dimension table. The same RPC powers both entry
 * points from the library batch bar:
 *   - mode="matrix": columns are user supplied comparison dimensions;
 *   - mode="ask":    the question becomes the single column and each cell is
 *                    that paper's evidence-backed answer.
 * Keeping both views on one RPC avoids a second, as-yet-untyped API surface.
 */

export type MatrixCell = { text: string; page?: number; version_id?: string };
export type MatrixRow = { paper_id: string; title: string; cells: Record<string, MatrixCell | undefined> };
export type SynthesisMatrix = { dimensions: string[]; rows: MatrixRow[] };

export const DEFAULT_DIMENSIONS = ["研究问题", "核心方法", "数据集与基线", "关键指标/结果", "主要局限"];

/** Split a human typed dimension list; empty means "use the backend defaults". */
export function parseDimensions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,，、;\n]/)) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.slice(0, 12);
}

/** Fill in dimensions the backend may have omitted and keep cells editable. */
export function normalizeMatrix(input: SynthesisMatrix): SynthesisMatrix {
  const rows = (input.rows || []).map((row) => ({ ...row, cells: { ...(row.cells || {}) } }));
  const dimensions = input.dimensions?.length ? input.dimensions : Object.keys(rows[0]?.cells || {});
  return { dimensions, rows };
}

const pageSuffix = (cell?: MatrixCell) => cell?.page != null ? ` [p.${cell.page + 1}]` : "";
const cellText = (cell?: MatrixCell) => `${cell?.text ?? ""}${pageSuffix(cell)}`.trim();
const escapeMarkdown = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
const csvField = (text: string) => /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

export function matrixToMarkdown(matrix: SynthesisMatrix): string {
  const header = `| 论文 | ${matrix.dimensions.map(escapeMarkdown).join(" | ")} |`;
  const divider = `| --- | ${matrix.dimensions.map(() => "---").join(" | ")} |`;
  const rows = matrix.rows.map((row) =>
    `| ${escapeMarkdown(row.title)} | ${matrix.dimensions.map((dimension) => escapeMarkdown(cellText(row.cells[dimension]))).join(" | ")} |`);
  return [header, divider, ...rows].join("\n");
}

export function matrixToCsv(matrix: SynthesisMatrix): string {
  const lines = [
    ["论文", ...matrix.dimensions].map(csvField).join(","),
    ...matrix.rows.map((row) => [row.title, ...matrix.dimensions.map((dimension) => cellText(row.cells[dimension]))].map(csvField).join(",")),
  ];
  return lines.join("\n");
}

type Props = {
  paperIds: string[];
  mode?: "matrix" | "ask";
  /** One-based page number; App resolves the paper and opens a reader tab. */
  onOpenPaper: (paperId: string, page: number) => void;
  onClose: () => void;
};

export default function SynthesisModal({ paperIds, mode = "matrix", onOpenPaper, onClose }: Props) {
  const [dimensionText, setDimensionText] = useState("");
  const [question, setQuestion] = useState("");
  const [matrix, setMatrix] = useState<SynthesisMatrix | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const ask = mode === "ask";

  const heading = ask ? "跨论文提问" : "生成对比矩阵";
  const intro = ask
    ? `对所选 ${paperIds.length} 篇论文逐篇回答同一问题，每个单元格来自原文证据并尽量标注页码。`
    : `对所选 ${paperIds.length} 篇论文生成可编辑对比矩阵；留空维度则使用后端默认列。`;
  const ready = useMemo(() => ask ? question.trim().length > 0 : true, [ask, question]);

  const generate = async () => {
    if (!ready) { setError("请输入要跨论文比较的问题"); return; }
    setLoading(true); setError(""); setStatus("");
    try {
      const dimensions = ask ? [question.trim()] : parseDimensions(dimensionText);
      const result = await api.synthesisMatrix(paperIds, dimensions.length ? dimensions : undefined);
      setMatrix(normalizeMatrix(result));
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const editCell = (paperId: string, dimension: string, text: string) => {
    setMatrix((current) => current && ({
      ...current,
      rows: current.rows.map((row) => row.paper_id === paperId
        ? { ...row, cells: { ...row.cells, [dimension]: { ...(row.cells[dimension] || {}), text } } }
        : row),
    }));
  };

  const exportAs = async (format: "markdown" | "csv") => {
    if (!matrix) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const body = format === "markdown" ? matrixToMarkdown(matrix) : matrixToCsv(matrix);
    const name = `论文对比矩阵-${stamp}.${format === "markdown" ? "md" : "csv"}`;
    try {
      const result = await api.saveText(name, body);
      setStatus(result.saved ? `已导出 ${format === "markdown" ? "Markdown" : "CSV"}` : "已取消导出");
    } catch (e) {
      setError(`导出失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal synthesis-modal" role="dialog" aria-label={heading} onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{ask ? "💬 跨论文提问" : "📊 生成对比矩阵"}</h2>
            <p className="muted small">{intro}</p>
          </div>
          <button className="icon-btn" aria-label="关闭跨论文面板" onClick={onClose}><X size={18} /></button>
        </header>

        {ask ? (
          <label>问题
            <textarea aria-label="跨论文问题" rows={3} disabled={loading} value={question}
              placeholder="例如：这些工作分别如何降低推理显存？"
              onChange={(event) => setQuestion(event.target.value)} />
          </label>
        ) : (
          <label>对比维度（逗号分隔，留空使用默认维度）
            <input aria-label="对比维度" disabled={loading} value={dimensionText}
              placeholder={DEFAULT_DIMENSIONS.join(", ")}
              onChange={(event) => setDimensionText(event.target.value)} />
          </label>
        )}

        <div className="synthesis-toolbar">
          <button className="btn primary" onClick={() => void generate()} disabled={loading || !ready}>
            <Sparkles size={14} />{loading ? "正在分析…" : ask ? "提问" : "生成矩阵"}
          </button>
          {matrix && <>
            <button className="btn tiny" onClick={() => void exportAs("markdown")}><Download size={13} />导出 Markdown</button>
            <button className="btn tiny" onClick={() => void exportAs("csv")}><Download size={13} />导出 CSV</button>
          </>}
          <span className="muted small">结果表格可直接编辑，导出会包含修改。</span>
        </div>

        {loading && <p className="muted synthesis-loading" role="status">正在聚合跨论文证据并生成表格，可能需要几十秒…</p>}
        {error && <p className="error-box" role="alert">{error}</p>}
        {status && <p className="small" role="status">{status}</p>}

        {matrix && (
          <div className="matrix-wrap">
            <table className="matrix-table" aria-label="文献对比矩阵">
              <thead>
                <tr>
                  <th scope="col">论文</th>
                  {matrix.dimensions.map((dimension) => <th key={dimension} scope="col">{dimension}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={row.paper_id} data-paper-id={row.paper_id}>
                    <th scope="row" className="matrix-paper">{row.title}</th>
                    {matrix.dimensions.map((dimension) => {
                      const cell = row.cells[dimension];
                      return (
                        <td key={dimension}>
                          <textarea aria-label={`${row.title} · ${dimension}`} rows={3} value={cell?.text ?? ""}
                            onChange={(event) => editCell(row.paper_id, dimension, event.target.value)} />
                          {cell?.page != null && (
                            <button type="button" className="cell-page" title={`打开原文第 ${cell.page + 1} 页`}
                              aria-label={`打开 ${row.title} 第 ${cell.page + 1} 页`}
                              onClick={() => onOpenPaper(row.paper_id, cell.page! + 1)}>[p.{cell.page + 1}]</button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </section>
    </div>
  );
}
