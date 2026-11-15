import { useEffect, useMemo, useState } from "react";
import { CopyCheck, Loader2, X } from "lucide-react";
import { api } from "./api";
import type { Paper } from "./types";

type Group = { kind: string; key: string; paper_ids: string[]; count: number };

export default function DuplicateFinder({ onClose, onOpen }: { onClose: () => void; onOpen: (paper: Paper) => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [papers, setPapers] = useState<Record<string, Paper>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    api.listDuplicates().then(async (result) => {
      if (!alive) return;
      setGroups(result.groups || []);
      const ids = [...new Set((result.groups || []).slice(0, 30).flatMap((group) => group.paper_ids))];
      const rows = await Promise.all(ids.map((id) => api.getPaper(id).catch(() => null)));
      if (!alive) return;
      setPapers(Object.fromEntries(rows.filter(Boolean).map((paper) => [paper!.id, paper!])));
    }).catch((e) => { if (alive) { setGroups([]); setError((e as Error).message); } });
    return () => { alive = false; };
  }, []);

  const total = useMemo(() => (groups || []).reduce((sum, group) => sum + group.count, 0), [groups]);
  const kindLabel = (kind: string) => kind === "doi" ? "DOI" : kind === "arxiv" ? "arXiv" : kind === "title" ? "标题" : kind;

  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal duplicate-modal" onClick={(event) => event.stopPropagation()} aria-label="查找重复论文">
      <header className="modal-head">
        <div><h2>查找重复论文</h2><p className="muted small">按 DOI、arXiv（忽略 vN 版本号）与归一化标题分组；同一篇论文的不同下载会出现在一组。</p></div>
        <button className="icon-btn" aria-label="关闭重复论文" onClick={onClose}><X size={18} /></button>
      </header>
      {groups === null && <p className="muted small"><Loader2 className="spin" size={13} /> 正在扫描论文库…</p>}
      {groups && groups.length === 0 && <div className="tag-empty"><CopyCheck size={24} /><p>{error ? `扫描失败：${error}` : "没有发现重复论文。"}</p></div>}
      {groups && groups.length > 0 && <>
        <p className="small muted">共发现 {groups.length} 组疑似重复（涉及 {total} 条记录），当前只做检测，不改动任何论文。</p>
        <div className="duplicate-list">
          {groups.map((group) => <article className="duplicate-group" key={`${group.kind}:${group.key}`}>
            <div className="duplicate-head"><span className={`dup-kind ${group.kind}`}>{kindLabel(group.kind)}</span><span className="dup-key" title={group.key}>{group.key}</span><span className="muted small">{group.count} 条</span></div>
            {group.paper_ids.map((id) => {
              const paper = papers[id];
              return <div className="duplicate-row" key={id}>
                <span className="dup-title" title={paper?.title}>{paper?.title || id}</span>
                <span className="muted small">{paper?.year || ""}{paper?.venue ? ` · ${paper.venue}` : ""}</span>
                {paper && <button className="link" onClick={() => onOpen(paper)}>打开</button>}
              </div>;
            })}
          </article>)}
        </div>
      </>}
      <div className="modal-actions"><button className="btn" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
