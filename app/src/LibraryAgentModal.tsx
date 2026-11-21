import { useMemo, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { api } from "./api";
import type { Category, PaperSummary, Tag } from "./types";

/**
 * FEAT-AI-04: reviewable library-organising agent.
 *
 * `api.organizePlan` only *previews* a change set (no DB writes). The user
 * reviews the per-paper diff, unchecks anything they disagree with, and only
 * then do we call the existing transactional write APIs
 * (`bulkAssign` / `setShortNote` / `updatePaper`).
 */

export type OrganizeGoal = "categorize" | "tag" | "short_note";

export const GOALS: { value: OrganizeGoal; label: string }[] = [
  { value: "categorize", label: "自动归类到现有目录" },
  { value: "tag", label: "生成规范标签" },
  { value: "short_note", label: "一句话速记" },
];

export type PlanRow = { paper_id: string; title: string; before: unknown; after: unknown; reason: string };

type Props = {
  paperIds: string[];
  papers?: PaperSummary[];
  categories: Category[];
  tags: Tag[];
  onApplied: () => Promise<void> | void;
  onClose: () => void;
  onToast?: (message: string) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Render an opaque `before`/`after` diff value as the taxonomy name users know. */
export function describePlanValue(value: unknown, categories: Category[], tags: Tag[]): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.trim() || "（空）";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => {
      if (typeof entry === "string") return entry;
      const record = asRecord(entry);
      if (record && typeof record.name === "string") return record.name;
      return JSON.stringify(entry);
    }).filter((entry) => entry.length > 0);
    return parts.length ? parts.join("、") : "—";
  }
  const record = asRecord(value);
  if (!record) return String(value);
  if (typeof record.category_id === "string") return categories.find((item) => item.id === record.category_id)?.name || record.category_id;
  if (Array.isArray(record.category_ids)) return record.category_ids.map((id) => categories.find((item) => item.id === String(id))?.name || String(id)).join("、");
  if (Array.isArray(record.categories)) {
    const names = record.categories.map((entry) => typeof entry === "string" ? entry : String(asRecord(entry)?.name ?? entry)).filter(Boolean);
    return names.length ? names.join("、") : "（未分类）";
  }
  if (Array.isArray(record.tags)) {
    const names = record.tags.map((tag) => typeof tag === "string" ? tag : String((asRecord(tag)?.name ?? tag)));
    return names.length ? names.map((name) => `#${name}`).join(" ") : "（无标签）";
  }
  if (typeof record.short_note === "string") return record.short_note.trim() || "（清空速记）";
  const keys = Object.keys(record);
  if (!keys.length) return "—";
  return keys.map((key) => `${key}: ${describePlanValue(record[key], categories, tags)}`).join("；");
}

/** Group selected rows so one backend write covers as many papers as possible. */
export function applyBatches(rows: PlanRow[], goal: OrganizeGoal): { kind: OrganizeGoal; ids: string[]; value: unknown }[] {
  const groups = new Map<string, { kind: OrganizeGoal; ids: string[]; value: unknown }>();
  for (const row of rows) {
    const after = asRecord(row.after) || {};
    let key = "";
    let value: unknown = null;
    if (goal === "categorize" && typeof after.category_id === "string") {
      key = `categorize:${after.category_id}`; value = after.category_id;
    } else if (goal === "tag" && Array.isArray(after.tags) && after.tags.length) {
      const tags = after.tags.map((tag) => String(typeof tag === "string" ? tag : asRecord(tag)?.name ?? tag)).sort();
      key = `tag:${tags.join("\u0001")}`; value = after.tags.map((tag) => String(typeof tag === "string" ? tag : asRecord(tag)?.name ?? tag));
    } else if (goal === "short_note" && typeof after.short_note === "string") {
      key = `short_note:${row.paper_id}`; value = after.short_note;
    } else {
      throw new Error(`《${row.title}》的计划缺少可应用的 ${goal} 字段`);
    }
    const existing = groups.get(key);
    if (existing) existing.ids.push(row.paper_id);
    else groups.set(key, { kind: goal, ids: [row.paper_id], value });
  }
  return [...groups.values()];
}

export default function LibraryAgentModal({ paperIds, papers, categories, tags, onApplied, onClose, onToast }: Props) {
  const [goal, setGoal] = useState<OrganizeGoal>("categorize");
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  const selectedRows = useMemo(() => (plan || []).filter((row) => selected.has(row.paper_id)), [plan, selected]);
  const busy = loading || applying;

  const requestPlan = async (nextGoal: OrganizeGoal = goal) => {
    setLoading(true); setError(""); setPlan(null); setSelected(new Set());
    try {
      const result = await api.organizePlan(paperIds, nextGoal);
      const rows = result?.plan || [];
      setPlan(rows);
      setSelected(new Set(rows.map((row) => row.paper_id)));
      if (!rows.length) setError("模型没有给出任何整理建议，可换一个目标再试。");
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const chooseGoal = (next: OrganizeGoal) => {
    if (busy || next === goal) return;
    setGoal(next); setPlan(null); setSelected(new Set()); setError("");
  };

  const toggle = (paperId: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(paperId); else next.delete(paperId);
      return next;
    });
  };

  const apply = async () => {
    if (!plan || !selectedRows.length) return;
    setApplying(true); setError("");
    let applied = 0;
    try {
      // short notes need the row's updated_at for the optimistic lock; the plan
      // only carries text, so merge the summaries App already has.
      if (goal === "short_note") {
        let failed = 0;
        for (const row of selectedRows) {
          const after = asRecord(row.after);
          const text = typeof after?.short_note === "string" ? after.short_note : null;
          if (text === null) { failed++; continue; }
          const paper = papers?.find((item) => item.id === row.paper_id);
          try {
            if (paper) await api.setShortNote(row.paper_id, text, paper.updated_at);
            else await api.updatePaper(row.paper_id, { short_note: text });
            applied++;
          } catch { failed++; }
        }
        if (failed) throw new Error(`${failed} 条速记写入失败`);
      } else {
        for (const batch of applyBatches(selectedRows, goal)) {
          if (goal === "categorize") await api.bulkAssign({ paper_ids: batch.ids, category_id: String(batch.value), tags: [] });
          else await api.bulkAssign({ paper_ids: batch.ids, tags: batch.value as string[] });
          applied += batch.ids.length;
        }
      }
      await onApplied();
      onToast?.(`已应用 ${applied} 篇论文的整理变更`);
      onClose();
    } catch (e) {
      setError(`应用失败：${(e as Error).message}`);
    } finally {
      setApplying(false);
    }
  };

  const allSelected = !!plan?.length && selected.size === plan.length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="modal library-agent-modal" role="dialog" aria-label="整理 Agent" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>🤖 整理 Agent</h2>
            <p className="muted small">先预览变更（Plan），逐条勾选确认后再应用（Apply）；不会静默修改论文库。已选 {paperIds.length} 篇。</p>
          </div>
          <button className="icon-btn" aria-label="关闭整理 Agent" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="segmented agent-goals" role="group" aria-label="整理目标">
          {GOALS.map((item) => (
            <button type="button" key={item.value} className={goal === item.value ? "on" : ""} aria-pressed={goal === item.value}
              disabled={busy} onClick={() => chooseGoal(item.value)}>{item.label}</button>
          ))}
        </div>

        <div className="synthesis-toolbar">
          <button className="btn primary" disabled={busy} onClick={() => void requestPlan()}>
            <Sparkles size={14} />{loading ? "正在生成计划…" : plan ? "重新生成计划" : "生成整理计划"}
          </button>
          {plan && plan.length > 0 && (
            <label className="agent-select-all">
              <input type="checkbox" aria-label="全选整理建议" checked={allSelected}
                onChange={(event) => setSelected(event.target.checked ? new Set(plan.map((row) => row.paper_id)) : new Set())} />
              全选
            </label>
          )}
        </div>

        {loading && <p className="muted synthesis-loading" role="status">正在读取论文元数据、导读与现有分类…</p>}
        {error && <p className="error-box" role="alert">{error}</p>}

        {plan && plan.length > 0 && (
          <ul className="agent-plan-list" aria-label="整理变更预览">
            {plan.map((row) => (
              <li key={row.paper_id} className={`agent-plan-row ${selected.has(row.paper_id) ? "on" : ""}`}>
                <input type="checkbox" aria-label={`应用 ${row.title} 的变更`} checked={selected.has(row.paper_id)}
                  disabled={applying} onChange={(event) => toggle(row.paper_id, event.target.checked)} />
                <div className="agent-plan-body">
                  <div className="agent-plan-title">{row.title}</div>
                  <div className="agent-diff">
                    <span className="agent-before">当前：{describePlanValue(row.before, categories, tags)}</span>
                    <span className="agent-arrow" aria-hidden="true">→</span>
                    <span className="agent-after">计划：{describePlanValue(row.after, categories, tags)}</span>
                  </div>
                  {row.reason && <div className="agent-reason">理由：{row.reason}</div>}
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="modal-actions">
          <span className="muted small agent-count">已选 {selected.size} / {plan?.length ?? 0} 条</span>
          <button type="button" className="btn" disabled={applying} onClick={onClose}>取消</button>
          <button type="button" className="btn primary" disabled={busy || !selectedRows.length} onClick={() => void apply()}>
            <Check size={14} />{applying ? "正在应用…" : "应用已选变更"}
          </button>
        </div>
      </section>
    </div>
  );
}
