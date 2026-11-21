import { useEffect, useMemo, useState } from "react";
import { CopyCheck, Loader2, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Paper } from "./types";

type Group = { kind: string; key: string; paper_ids: string[]; count: number };
type Props = {
  onClose: () => void;
  onOpen: (paper: Paper) => void;
  /** Called after a merge/trash so the library page can refresh (FEAT-UX-02). */
  onChanged?: () => void;
};

const groupKey = (group: Group) => `${group.kind}:${group.key}`;

export default function DuplicateFinder({ onClose, onOpen, onChanged }: Props) {
  const client = useQueryClient();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [papers, setPapers] = useState<Record<string, Paper>>({});
  const [primary, setPrimary] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState("");

  /**
   * The merge updates several tables at once, so keep the local duplicate view
   * and the cached library query in sync instead of relying on a full reload.
   */
  const refreshLibrary = () => {
    onChanged?.();
    void client.invalidateQueries({ queryKey: ["papers"] });
    void client.invalidateQueries({ queryKey: ["taxonomy"] });
  };

  const load = async () => {
    const result = await api.listDuplicates();
    const next = result.groups || [];
    const ids = [...new Set(next.slice(0, 30).flatMap((group) => group.paper_ids))];
    const rows = await Promise.all(ids.map((id) => api.getPaper(id).catch(() => null)));
    return { next, rows: rows.filter(Boolean) as Paper[] };
  };

  useEffect(() => {
    let alive = true;
    load().then(({ next, rows }) => {
      if (!alive) return;
      setGroups(next);
      setPapers(Object.fromEntries(rows.map((paper) => [paper.id, paper])));
      setPrimary(Object.fromEntries(next.map((group) => [groupKey(group), group.paper_ids[0] ?? ""])));
    }).catch((e) => { if (alive) { setGroups([]); setError((e as Error).message); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reload = async () => {
    const { next, rows } = await load();
    setGroups(next);
    setPapers((old) => ({ ...old, ...Object.fromEntries(rows.map((paper) => [paper.id, paper])) }));
    setPrimary((old) => Object.fromEntries(next.map((group) => {
      const key = groupKey(group);
      const chosen = old[key];
      return [key, chosen && group.paper_ids.includes(chosen) ? chosen : group.paper_ids[0] ?? ""];
    })));
  };

  const total = useMemo(() => (groups || []).reduce((sum, group) => sum + group.count, 0), [groups]);
  const kindLabel = (kind: string) => kind === "doi" ? "DOI" : kind === "arxiv" ? "arXiv" : kind === "title" ? "标题" : kind;

  /** Impact of keeping `primaryId`: how much material moves onto the kept row. */
  const impactOf = (group: Group) => {
    const key = groupKey(group);
    const primaryId = primary[key] || group.paper_ids[0] || "";
    const others = group.paper_ids.filter((id) => id !== primaryId);
    const versions = others.reduce((sum, id) => sum + (papers[id]?.versions?.length || 0), 0);
    const notes = others.filter((id) => (papers[id]?.notes || "").trim().length > 0).length;
    return { primaryId, others, versions, notes };
  };

  const merge = async (group: Group) => {
    const key = groupKey(group);
    const { primaryId, others, versions, notes } = impactOf(group);
    if (!primaryId || others.length === 0) return;
    const title = papers[primaryId]?.title || primaryId;
    const question = `将 ${others.length} 条重复记录合并到「${title}」？\n\n将合入 ${versions} 个 PDF 版本${notes ? `、${notes} 条笔记` : ""}，批注、标签与目录一并迁移，次条目随后删除。`;
    if (typeof confirm === "function" && !confirm(question)) return;
    setBusy(key); setError(""); setStatus("");
    try {
      const result = await api.mergePapers(primaryId, others);
      setStatus(`已合并 ${result?.merged ?? others.length} 条重复记录 →「${title}」`);
      refreshLibrary();
      await reload();
    } catch (e) {
      setError(`合并失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  const trashRow = async (paperId: string) => {
    setBusy(paperId); setError(""); setStatus("");
    try {
      await api.trash(paperId);
      setStatus(`已移入回收站：${papers[paperId]?.title || paperId}`);
      refreshLibrary();
      await reload();
    } catch (e) {
      setError(`移入回收站失败：${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal duplicate-modal" onClick={(event) => event.stopPropagation()} aria-label="查找重复论文">
      <header className="modal-head">
        <div><h2>查找重复论文</h2><p className="muted small">按 DOI、arXiv（忽略 vN 版本号）与归一化标题分组。选择每组保留的主条目后合并：PDF 版本、批注、笔记、标签与目录都会迁移到主条目。</p></div>
        <button className="icon-btn" aria-label="关闭重复论文" onClick={onClose}><X size={18} /></button>
      </header>
      {groups === null && <p className="muted small"><Loader2 className="spin" size={13} /> 正在扫描论文库…</p>}
      {groups && groups.length === 0 && <div className="tag-empty"><CopyCheck size={24} /><p>{error ? `扫描失败：${error}` : "没有发现重复论文。"}</p></div>}
      {groups && groups.length > 0 && <>
        <p className="small muted">共发现 {groups.length} 组疑似重复（涉及 {total} 条记录）。默认保留每组的第一条，可切换主条目后再合并。</p>
        <div className="duplicate-list">
          {groups.map((group) => {
            const key = groupKey(group);
            const { primaryId, others, versions, notes } = impactOf(group);
            const merging = busy === key;
            return <article className="duplicate-group" key={key} data-group={key}>
              <div className="duplicate-head"><span className={`dup-kind ${group.kind}`}>{kindLabel(group.kind)}</span><span className="dup-key" title={group.key}>{group.key}</span><span className="muted small">{group.count} 条</span></div>
              {group.paper_ids.map((id) => {
                const paper = papers[id];
                const isPrimary = id === primaryId;
                return <div className={`duplicate-row ${isPrimary ? "is-primary" : ""}`} key={id}>
                  <label className="dup-primary" title="保留为主条目">
                    <input type="radio" name={`dup-primary-${key}`} aria-label={`保留 ${paper?.title || id} 为主条目`} checked={isPrimary}
                      onChange={() => setPrimary((old) => ({ ...old, [key]: id }))} />
                    <span>{isPrimary ? "主条目" : "合入"}</span>
                  </label>
                  <span className="dup-title" title={paper?.title}>{paper?.title || id}</span>
                  <span className="muted small">{paper?.year || ""}{paper?.venue ? ` · ${paper.venue}` : ""}</span>
                  {paper && <button className="link" onClick={() => onOpen(paper)}>打开</button>}
                  <button className="btn tiny ghost dup-trash" disabled={busy === id} onClick={() => void trashRow(id)} title="移入回收站">
                    <Trash2 size={12} />移入回收站
                  </button>
                </div>;
              })}
              <div className="duplicate-actions">
                <span className="dup-impact" role="status">
                  {others.length === 0 ? "已全部选定为主条目" : `将合入 ${others.length} 条（${versions} 个 PDF 版本${notes ? `、${notes} 条笔记` : ""}）+ 批注、标签与目录`}
                </span>
                <button className="btn primary tiny" disabled={others.length === 0 || merging} onClick={() => void merge(group)}>
                  {merging ? <><Loader2 className="spin" size={13} />合并中…</> : "合并为一条"}
                </button>
              </div>
            </article>;
          })}
        </div>
      </>}
      {status && <p className="small dup-status" role="status">{status}</p>}
      {error && groups && groups.length > 0 && <p className="small error-box" role="alert">{error}</p>}
      <div className="modal-actions"><button className="btn" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
