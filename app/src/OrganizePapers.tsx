import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "./api";
import type { Category, Tag } from "./types";
import { folderRows } from "./folders";

export default function OrganizePapers({ ids, categories, tags, onSaved, onClose }: { ids: string[]; categories: Category[]; tags: Tag[]; onSaved: () => Promise<void>; onClose: () => void }) {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [folder, setFolder] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows = useMemo(() => folderRows(categories), [categories]);
  const selectedTags = useMemo(() => [...new Set(text.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))], [text]);
  const toggle = (name: string) => setText((all) => {
    const current = [...new Set(all.split(/[,，\n]/).map((tag) => tag.trim()).filter(Boolean))];
    return (current.includes(name) ? current.filter((tag) => tag !== name) : [...current, name]).join(", ");
  });
  const save = async () => {
    setBusy(true); setError("");
    try {
      if (mode === "add") await api.bulkAssign({ paper_ids: ids, category_id: folder || undefined, tags: selectedTags });
      else await api.bulkUnassign({ paper_ids: ids, category_id: folder || undefined, tags: selectedTags });
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal organize-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <header className="modal-head">
          <div><h2>分类与标签</h2><p className="muted small">已选 {ids.length} 篇论文 · {mode === "add" ? "只添加，不移除已有归类。" : "只移除所选归类，不删除论文。"}</p></div>
          <button type="button" className="icon-btn" aria-label="关闭分类标签" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="segmented organize-mode" role="group" aria-label="归类操作">
          <button type="button" aria-pressed={mode === "add"} className={mode === "add" ? "on" : ""} onClick={() => setMode("add")}>添加归类</button>
          <button type="button" aria-pressed={mode === "remove"} className={mode === "remove" ? "on" : ""} onClick={() => setMode("remove")}>移除归类</button>
        </div>
        <div className="editor-grid">
          <label className="span-2">{mode === "add" ? "添加到目录" : "从目录移除"}
            <select aria-label="添加到目录" disabled={busy} value={folder} onChange={(event) => setFolder(event.target.value)}>
              <option value="">{mode === "add" ? "不添加目录" : "不移除目录"}</option>
              {rows.map((row) => <option key={row.id} value={row.id}>{row.path}</option>)}
            </select>
          </label>
          <label className="span-2">{mode === "add" ? "添加标签（逗号分隔）" : "移除标签（逗号分隔）"}<input aria-label="批量标签" disabled={busy} value={text} onChange={(event) => setText(event.target.value)} placeholder="例如：强化学习，待读" /></label>
        </div>
        {tags.length > 0 && (
          <fieldset className="pill-field" aria-label="已有标签">
            <legend>点选已有标签</legend>
            <div className="pill-list">
              {tags.slice(0, 40).map((tag) => (
                <label key={tag.id} className={`pill ${selectedTags.includes(tag.name) ? "on" : ""}`}>
                  <input type="checkbox" checked={selectedTags.includes(tag.name)} onChange={() => toggle(tag.name)} />
                  {selectedTags.includes(tag.name) && <Check size={12} />}
                  <span>#{tag.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {error && <p className="error-box" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || (!folder && !selectedTags.length)}>{mode === "add" ? "保存分类与标签" : "移除所选归类"}</button>
        </div>
      </form>
    </div>
  );
}
