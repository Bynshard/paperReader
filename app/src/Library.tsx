import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { PaperSort, PaperSummary } from "./types";

type Props = {
  papers: PaperSummary[];
  total: number; loading: boolean; error?: string;
  sort: PaperSort; onSort: (sort: PaperSort) => void;
  offset: number; pageSize: number; onOffset: (offset: number) => void;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (p: PaperSummary) => void;
  onImport: () => void;
  onToggleFavorite: (p: PaperSummary) => void;
  onTrash: (p: PaperSummary) => void;
  onRestore: (p: PaperSummary) => void;
  onPurge: (p: PaperSummary) => void;
  onExport: (p: PaperSummary, fmt: "bibtex" | "ris") => void;
  onEdit?: (p:PaperSummary)=>void;
  onZotero: () => void;
  importing: boolean;
  importProgress?: string;
};

export default function Library({ papers, total, loading, error, sort, onSort, offset, pageSize, onOffset, query, onQuery, onOpen, onImport, onToggleFavorite, onTrash, onRestore, onPurge, onExport, onEdit, onZotero, importing, importProgress }: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: papers.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 130, getItemKey: (index) => papers[index].id, overscan: 4,
  });
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); setMenu(null); }, [offset, sort, query]);

  return (
    <div className="library">
      <div className="library-head">
        <div>
          <h1>论文库</h1>
          <p className="muted">{total.toLocaleString()} 篇{loading ? " · 加载中…" : ""} · 原文离线可读，译文按需生成</p>
        </div>
        <div className="library-actions">
          <input className="search" placeholder="搜索标题、作者、DOI 或正文…" value={query} onChange={(e) => onQuery(e.target.value)} />
          <select aria-label="论文排序" value={sort} onChange={(e) => onSort(e.target.value as PaperSort)} className="select">
            <option value="recent">最近导入</option>
            <option value="title">标题</option>
            <option value="year">年份</option>
          </select>
          <button className="btn" onClick={onZotero}>
            从 Zotero 导入
          </button>
          <button className="btn primary" onClick={onImport} disabled={importing}>
            {importing ? `导入中${importProgress ? ` ${importProgress}` : '…'}` : "导入 PDF"}
          </button>
        </div>
      </div>

      {error && <div className="error-box" role="alert">加载失败：{error}</div>}
      {papers.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">◫</div>
          <h2>{loading ? "正在加载论文…" : query ? "没有匹配的论文" : "当前分类没有论文"}</h2>
          <p>导入 PDF 后即可离线阅读；翻译、解释与问答按需调用已配置的模型。</p>
          <button className="btn primary" onClick={onImport}>
            导入 PDF
          </button>
        </div>
      ) : (
        <div className="paper-list" ref={scrollRef} aria-label="论文列表">
          <div style={{ height: virtual.getTotalSize(), width: "100%", position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const p = papers[item.index];
            const translated = p.has_translation;
            return (
              <div key={item.key} data-index={item.index} ref={virtual.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", paddingBottom: 8, transform: `translateY(${item.start}px)`, zIndex: menu === p.id ? 20 : undefined }}>
              <div className={`paper-row ${p.deleted ? "deleted" : ""}`} data-paper-id={p.id} onDoubleClick={() => onOpen(p)}>
                <button className={`star ${p.favorite ? "on" : ""}`} title="星标" onClick={() => onToggleFavorite(p)}>
                  ★
                </button>
                <div className="paper-main" onClick={() => onOpen(p)}>
                  <div className="paper-title">{p.title}</div>
                  <div className="paper-meta">
                    <span>{p.authors || "未知作者"}</span>
                    {p.year && <span>{p.year}</span>}
                    {p.venue && <span>{p.venue}</span>}
                    {p.doi && <span className="mono">DOI {p.doi}</span>}
                    {p.arxiv && <span className="mono">arXiv:{p.arxiv}</span>}
                  </div>
                  <div className="paper-tags">
                    {p.categories.map((c) => (
                      <span className="chip" key={c.id}>
                        {c.name}
                      </span>
                    ))}
                    {p.tags.map((t) => (
                      <span className="chip ghost" key={t.id}>
                        #{t.name}
                      </span>
                    ))}
                    {translated && <span className="chip accent">已有译文</span>}
                    {p.read_status === "read" && <span className="chip">已读</span>}
                  </div>
                </div>
                <div className="paper-side">
                  <div className="row-actions">
                    <button className="btn tiny" onClick={() => onOpen(p)}>
                      阅读
                    </button>
                    <button className="btn tiny ghost" onClick={() => setMenu(menu === p.id ? null : p.id)}>
                      ⋯
                    </button>
                  </div>
                  {menu === p.id && (
                    <div className="menu" onMouseLeave={() => setMenu(null)}>
                      {!p.deleted && (
                        <>
                          <button onClick={()=>{setMenu(null);onEdit?.(p);}}>编辑资料</button>
                          <button onClick={() => onExport(p, "bibtex")}>导出 BibTeX</button>
                          <button onClick={() => onExport(p, "ris")}>导出 RIS</button>
                          <button className="danger" onClick={() => onTrash(p)}>
                            移到回收站
                          </button>
                        </>
                      )}
                      {p.deleted && (
                        <>
                          <button onClick={() => onRestore(p)}>恢复</button>
                          <button className="danger" onClick={() => onPurge(p)}>
                            永久删除
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
            );
          })}
          </div>
        </div>
      )}
      <div className="pagination">
        <button className="btn tiny" disabled={loading || offset === 0} onClick={() => onOffset(Math.max(0, offset-pageSize))}>上一页</button>
        <span>{total ? `${offset + 1}–${Math.min(offset+pageSize,total)} / ${total.toLocaleString()}` : "0 篇"}</span>
        <button className="btn tiny" disabled={loading || offset+pageSize >= total} onClick={() => onOffset(offset+pageSize)}>下一页</button>
      </div>
    </div>
  );
}
