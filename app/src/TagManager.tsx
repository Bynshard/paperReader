import { useEffect, useMemo, useState } from "react";
import { Palette, Tag, Trash2 } from "lucide-react";
import { api } from "./api";
import type { Tag as TagType } from "./types";

const SWATCHES = ["#256353", "#8158a0", "#366ca0", "#97601f", "#9a4d63", "#4d6b34", "#a63b32", "#6b7076"];

/** Rename, recolor and delete tags without touching the papers themselves. */
export default function TagManager({ tags, onChanged, onClose }: { tags: TagType[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [name, setName] = useState("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const visible = useMemo(() => tags.filter((tag) => tag.name.toLowerCase().includes(filter.trim().toLowerCase())), [tags, filter]);
  const current = tags.find((tag) => tag.id === selected);

  useEffect(() => {
    setName(current?.name || "");
    setColor(current?.color || "");
    setError(""); setMessage("");
  }, [selected, current?.name, current?.color]);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true); setError("");
    try { await action(); await onChanged(); setMessage(done); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!current) return;
    void run(async () => {
      if (name.trim() && name.trim() !== current.name) await api.tagRename(current.id, name.trim());
      if ((color || "") !== (current.color || "")) await api.tagSetColor(current.id, color);
    }, "标签已更新");
  };
  const remove = () => {
    if (!current) return;
    if (!confirm(`删除标签「${current.name}」？只会解除论文与该标签的关联，不会删除论文。`)) return;
    void run(async () => {
      const result = await api.tagDelete(current.id);
      setSelected("");
      setMessage(`标签已删除，${result.papers_unassigned} 篇论文解除关联`);
    }, "标签已删除");
  };

  return <div className="modal-backdrop" onClick={onClose}>
    <section className="modal tag-manager" onClick={(event) => event.stopPropagation()} aria-label="管理标签">
      <header className="modal-head">
        <div><h2>管理标签</h2><p className="muted small">重命名、改色或删除标签；删除只解除论文关联。</p></div>
        <button className="icon-btn" aria-label="关闭标签管理" onClick={onClose}>×</button>
      </header>
      <div className="tag-manager-body">
        <div className="tag-list">
          <input aria-label="筛选标签" placeholder="筛选标签…" value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="tag-list-scroll">
            {visible.length === 0 && <p className="muted small">没有匹配的标签。</p>}
            {visible.map((tag) => <button key={tag.id} className={`tag-list-row ${selected === tag.id ? "on" : ""}`} onClick={() => setSelected(tag.id)}>
              <span className="tag-color" style={{ background: tag.color || "#c9c6bb" }} />
              <span className="tag-name">{tag.name}</span>
              <Tag size={13} />
            </button>)}
          </div>
        </div>
        <div className="tag-editor">
          {!current && <div className="tag-empty"><Palette size={22} /><p>从左侧选择一个标签进行编辑。</p></div>}
          {current && <>
            <label>标签名称<input aria-label="标签名称" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
            <div className="tag-swatches" role="group" aria-label="标签颜色">
              {SWATCHES.map((value) => <button key={value} className={`swatch ${color === value ? "on" : ""}`} style={{ background: value }} aria-label={`使用颜色 ${value}`} onClick={() => setColor(value)} />)}
              <button className={`swatch clear ${color ? "" : "on"}`} aria-label="清除颜色" onClick={() => setColor("")}>无</button>
            </div>
            <p className="muted small">颜色会显示在论文标签胶囊上，保存后立即生效。</p>
            {error && <p className="error-box" role="alert">{error}</p>}
            {message && <p className="report-box" role="status">{message}</p>}
            <div className="row-actions">
              <button className="btn primary" disabled={busy} onClick={save}>保存标签</button>
              <button className="btn danger" disabled={busy} onClick={remove}><Trash2 size={13} />删除标签</button>
            </div>
          </>}
        </div>
      </div>
    </section>
  </div>;
}
