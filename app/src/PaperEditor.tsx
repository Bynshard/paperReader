import { useEffect, useMemo, useState } from "react";
import { Check, Plus, Wand2, X } from "lucide-react";
import { api } from "./api";
import { folderRows } from "./folders";
import type { Category, Paper, Tag } from "./types";

const TEXT_FIELDS = ["title", "authors", "year", "venue", "doi", "arxiv"] as const;
const TEXT_LABELS: Record<(typeof TEXT_FIELDS)[number], string> = { title: "标题", authors: "作者", year: "年份", venue: "期刊或会议", doi: "DOI", arxiv: "arXiv" };

export default function PaperEditor({ paper, onSaved, onClose }: { paper: Paper; onSaved: (p: Paper) => void; onClose: () => void }) {
  const [fields, setFields] = useState<Record<string, string>>(() => Object.fromEntries([...TEXT_FIELDS, "abstract", "notes", "read_status", "short_note"].map((key) => [key, String((paper as unknown as Record<string, unknown>)[key] ?? "")])));
  const [taxonomy, setTaxonomy] = useState<Category[]>([]);
  const [knownTags, setKnownTags] = useState<Tag[]>([]);
  const [ids, setIds] = useState(paper.categories.map((c) => c.id));
  const [tags, setTags] = useState(paper.tags.map((t) => t.name).join(", "));
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filling, setFilling] = useState(false);
  const [fillMessage, setFillMessage] = useState("");

  useEffect(() => {
    api.taxonomy().then((data) => { setTaxonomy(data.categories); setKnownTags(data.tags); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const rows = useMemo(() => folderRows(taxonomy), [taxonomy]);
  const tagList = useMemo(() => tags.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean), [tags]);

  const set = (key: string, value: string) => setFields((all) => ({ ...all, [key]: value }));
  const toggleCategory = (id: string) => setIds((all) => all.includes(id) ? all.filter((value) => value !== id) : [...all, id]);
  const toggleTag = (name: string) => setTags((all) => {
    const current = all.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean);
    return current.includes(name) ? current.filter((tag) => tag !== name).join(", ") : [...current, name].join(", ");
  });

  const fill = async () => {
    setFilling(true); setError(""); setFillMessage("");
    try {
      const fresh = await api.refreshMetadata(paper.id, false);
      const keys = ["title", "authors", "year", "venue", "doi", "arxiv", "abstract"] as const;
      setFields((all) => ({ ...all, ...Object.fromEntries(keys.map((key) => [key, String((fresh as unknown as Record<string, unknown>)[key] ?? all[key] ?? "")])) }));
      setFillMessage(fresh.updated_fields?.length ? `已补全：${fresh.updated_fields.join("、")}（${fresh.metadata_source}）` : "字段已是最新，没有可补全内容");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFilling(false);
    }
  };
  const save = async () => {
    setBusy(true); setError("");
    try {
      const fresh = await api.savePaper({ paper_id: paper.id, expected_updated_at: paper.updated_at, fields, category_ids: ids, tags: tagList });
      onSaved(fresh);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    setBusy(true); setError("");
    try {
      const item = await api.addCategory(category.trim());
      setTaxonomy((old) => [...old, item]);
      setIds((old) => [...old, item.id]);
      setCategory("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal paper-editor" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <header className="modal-head">
          <div>
            <h2>编辑论文资料</h2>
            <p className="muted small">逐项修改，保存后立即写入本地论文库。</p>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭编辑" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="editor-toolbar">
          <button type="button" className="btn tiny" disabled={filling} onClick={() => void fill()}><Wand2 size={13} />{filling ? "正在查询…" : "通过 DOI / arXiv 自动补全"}</button>
          {fillMessage && <span className="muted small" role="status">{fillMessage}</span>}
        </div>

        <div className="editor-grid">
          <label className="span-2">标题<input aria-label="标题" required value={fields.title} onChange={(e) => set("title", e.target.value)} /></label>
          <label className="span-2">作者<input aria-label="作者" value={fields.authors} onChange={(e) => set("authors", e.target.value)} /></label>
          <label>年份<input aria-label="年份" inputMode="numeric" value={fields.year} onChange={(e) => set("year", e.target.value)} /></label>
          <label>期刊或会议<input aria-label="期刊或会议" value={fields.venue} onChange={(e) => set("venue", e.target.value)} /></label>
          <label>DOI<input aria-label="DOI" className="mono" value={fields.doi} onChange={(e) => set("doi", e.target.value)} /></label>
          <label>arXiv<input aria-label="arXiv" className="mono" value={fields.arxiv} onChange={(e) => set("arxiv", e.target.value)} /></label>
          <label>阅读状态
            <select aria-label="阅读状态" value={fields.read_status} onChange={(e) => set("read_status", e.target.value)}>
              <option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option>
            </select>
          </label>
          <label>一句话速记<input aria-label="一句话速记" maxLength={300} placeholder="用一句话记住这篇论文的贡献或用途" value={fields.short_note} onChange={(e) => set("short_note", e.target.value)} /></label>
        </div>

        <fieldset className="pill-field" aria-label="论文分类">
          <legend>分类</legend>
          <div className="pill-list">
            {rows.length === 0 && <span className="muted small">还没有分类，可在下方新建。</span>}
            {rows.map((row) => (
              <label key={row.id} className={`pill ${ids.includes(row.id) ? "on" : ""}`} title={row.path}>
                <input type="checkbox" checked={ids.includes(row.id)} onChange={() => toggleCategory(row.id)} />
                {ids.includes(row.id) && <Check size={12} />}
                <span>{row.path}</span>
              </label>
            ))}
          </div>
          <div className="pill-create">
            <input aria-label="新分类" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="新建分类" />
            <button type="button" className="btn tiny" disabled={busy || !category.trim()} onClick={() => void create()}><Plus size={13} />新建</button>
          </div>
        </fieldset>

        <fieldset className="pill-field" aria-label="标签选择">
          <legend>标签</legend>
          <label className="field">标签（逗号分隔）<input aria-label="论文标签" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例如：强化学习, 待读" /></label>
          <div className="pill-list">
            {knownTags.map((tag) => (
              <label key={tag.id} className={`pill ${tagList.includes(tag.name) ? "on" : ""}`}>
                <input type="checkbox" checked={tagList.includes(tag.name)} onChange={() => toggleTag(tag.name)} />
                {tagList.includes(tag.name) && <Check size={12} />}
                <span>#{tag.name}</span>
              </label>
            ))}
            {knownTags.length === 0 && <span className="muted small">输入后保存即可创建标签。</span>}
          </div>
        </fieldset>

        <div className="editor-grid">
          <label className="span-2">摘要<textarea aria-label="论文摘要" rows={3} value={fields.abstract} onChange={(e) => set("abstract", e.target.value)} /></label>
          <label className="span-2">笔记<textarea aria-label="论文笔记" rows={5} value={fields.notes} onChange={(e) => set("notes", e.target.value)} /></label>
        </div>

        {error && <p className="error-box" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn primary" type="submit" disabled={busy}>{busy ? "保存中…" : "保存资料"}</button>
        </div>
      </form>
    </div>
  );
}
