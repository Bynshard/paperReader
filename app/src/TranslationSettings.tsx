import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, PlugZap, ScanSearch } from "lucide-react";
import { api, type TranslationSettings as Settings } from "./api";

type Diagnostic = { ok?: boolean; error?: string; model?: string; latency_ms?: number; version?: string; path?: string } | null;

export default function TranslationSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [checking, setChecking] = useState<"" | "api" | "babeldoc">("");
  const [diagnostic, setDiagnostic] = useState<Diagnostic>(null);

  useEffect(() => { void api.translationAction("status").then((value) => setSettings(value as Settings)).catch((e) => setError(e.message)); }, []);
  const change = (field: string, value: string | number) => setSettings((current) => current ? { ...current, [field]: value } : current);
  const save = async () => {
    setBusy(true); setError(""); setSaved("");
    try {
      const next = await api.translationAction("save", { ...settings, api_key: key }) as Settings;
      setSettings(next);
      setKey("");
      setSaved(next.pending_restart ? "配置已保存，重启软件后生效" : "配置已保存并即时生效（无需重启）");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const testApi = async () => {
    setChecking("api"); setDiagnostic(null); setError("");
    try {
      const result = await api.translationAction("test", { base_url: settings?.base_url, model: settings?.model, api_key: key }) as Diagnostic;
      setDiagnostic(result);
    } catch (e) { setDiagnostic({ ok: false, error: (e as Error).message }); }
    finally { setChecking(""); }
  };
  const checkBabeldoc = async () => {
    setChecking("babeldoc"); setDiagnostic(null); setError("");
    try {
      const result = await api.translationAction("checkBabeldoc", { path: settings?.babeldoc }) as Diagnostic;
      setDiagnostic(result);
    } catch (e) { setDiagnostic({ ok: false, error: (e as Error).message }); }
    finally { setChecking(""); }
  };

  return <section className="ai-settings translation-settings"><h3>翻译 API 与 PDF 引擎</h3>
    <p className="small muted">支持 OpenAI 兼容的 Chat Completions 接口，用于选区翻译和 API 问答。整篇 PDF 原位翻译另外需要 BabelDOC。</p>
    {settings && <>
      <label>API Base URL<input aria-label="翻译 API 地址" type="url" placeholder="https://你的服务地址/v1" value={settings.base_url} onChange={(e) => change("base_url", e.target.value)} /></label>
      <label>API Key<input aria-label="翻译 API Key" type="password" autoComplete="off" value={key} placeholder={settings.key_configured ? "已配置；留空保留当前 Key" : "请输入 API Key"} onChange={(e) => setKey(e.target.value)} /></label>
      <label>模型 ID<input aria-label="翻译模型 ID" placeholder="填写服务提供的准确模型 ID" value={settings.model} onChange={(e) => change("model", e.target.value)} /></label>
      <label>翻译 QPS<input aria-label="翻译 QPS" type="number" min="1" max="20" value={settings.qps} onChange={(e) => change("qps", Number(e.target.value))} /></label>
      <label>BabelDOC 可执行文件（可选）<input aria-label="BabelDOC 路径" value={settings.babeldoc} placeholder="留空则从系统 PATH 查找 babeldoc" onChange={(e) => change("babeldoc", e.target.value)} /></label>
      <p className="small muted">Windows 便携包已内置 BabelDOC（含 Python 运行时），无需另行安装；首次翻译会自动下载版式模型与字体（约 100–200MB，之后离线可复用）。仅在需要自定义版本/排障时，才填写外部 <code>babeldoc.exe</code> 路径。</p>
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void api.translationAction("pickBabeldoc").then((p) => { if (p) change("babeldoc", String(p)); }).catch((e) => setError(e.message))}>选择 BabelDOC</button>
        <button className="btn" disabled={busy || checking === "api"} onClick={() => void testApi()}>{checking === "api" ? <Loader2 className="spin" size={14} /> : <PlugZap size={14} />}测试 API 连接</button>
        <button className="btn" disabled={busy || checking === "babeldoc"} onClick={() => void checkBabeldoc()}>{checking === "babeldoc" ? <Loader2 className="spin" size={14} /> : <ScanSearch size={14} />}检查 BabelDOC</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : "保存翻译配置"}</button>
        {settings.pending_restart && <button className="btn" disabled={busy} onClick={() => void api.translationAction("restart").catch((e) => setError(e.message))}>重启并应用配置</button>}
      </div>
      {saved && <p className="report-box" role="status">{saved}</p>}
      {diagnostic && <p className={diagnostic.ok ? "report-box" : "error-box"} role={diagnostic.ok ? "status" : "alert"}>
        {diagnostic.ok
          ? <><CheckCircle2 size={13} /> {diagnostic.model ? `连接成功 · 模型 ${diagnostic.model}` : "检查通过"}{diagnostic.latency_ms != null ? ` · ${diagnostic.latency_ms} ms` : ""}{diagnostic.path ? ` · ${diagnostic.path}` : ""}{diagnostic.version ? ` · ${diagnostic.version}` : ""}</>
          : `检查失败：${diagnostic.error || "未知错误"}`}
      </p>}
      {settings.pending_restart && <p className="small muted" role="status">配置已保存，重启软件后生效；请先完成正在进行的导入和任务。</p>}
      <p className="small muted">Key 由系统凭据存储加密，保存在本机应用设置中，不随论文库同步。OCR 在本机进行，无需 API Key。</p>
    </>}
    {(error || settings?.error) && <p className="error-box" role="alert">{error || settings?.error}</p>}
  </section>;
}
