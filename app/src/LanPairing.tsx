import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw, Tablet, Wifi, WifiOff } from "lucide-react";
import QrSvg from "./qr/QrSvg";
import "./lan-pairing.css";

/** Shape returned by the desktop main process `lan:info` IPC handler. */
export type LanInfo = {
  enabled: boolean;
  port: number;
  running: boolean;
  urls: string[];
};

type LanBridge = {
  lanInfo: () => Promise<LanInfo>;
  configureLan: (input: { enabled: boolean; port: number; rotateToken?: boolean }) => Promise<{ restart_required?: boolean; rotated?: boolean }>;
};

/**
 * The pairing card only makes sense in the desktop shell.  On the tablet the
 * page is served by the LAN backend, so `window.moonlight` (the preload bridge)
 * does not exist and we render an explanatory fallback instead of crashing.
 */
function lanBridge(): LanBridge | null {
  const candidate =
    typeof window === "undefined"
      ? undefined
      : (window.moonlight as unknown as Partial<LanBridge> | undefined);
  if (!candidate || typeof candidate.lanInfo !== "function" || typeof candidate.configureLan !== "function") {
    return null;
  }
  return candidate as LanBridge;
}

function parsePort(value: string): number | null {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

export default function LanPairing() {
  const bridge = useMemo(lanBridge, []);
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [port, setPort] = useState("8765");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      const next = await bridge.lanInfo();
      setInfo(next);
      setEnabled(next.enabled);
      setPort(String(next.port));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async (url: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const area = document.createElement("textarea");
        area.value = url;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand?.("copy");
        document.body.removeChild(area);
        if (!ok) throw new Error("clipboard unavailable");
      }
      setCopied(url);
      setError("");
      window.setTimeout(() => setCopied((current) => (current === url ? "" : current)), 2000);
    } catch {
      setError("复制失败，请手动选中链接复制");
    }
  };

  const save = async () => {
    if (!bridge) return;
    const nextPort = parsePort(port);
    if (nextPort === null) {
      setError("端口需为 1024–65535 之间的整数");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bridge.configureLan({ enabled, port: nextPort });
      setNotice(result?.restart_required === false ? "设置已保存" : "设置已保存，重启 Moonlight 后生效");
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Manual rotation: only used when the user suspects the pairing link leaked.
  // It always reuses the *persisted* port/enabled state from `info`, so an
  // unsaved port edit in the form is not accidentally committed.
  const rotateToken = async () => {
    if (!bridge) return;
    const currentPort = info ? info.port : parsePort(port);
    if (currentPort === null) {
      setError("端口需为 1024–65535 之间的整数");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await bridge.configureLan({
        enabled: info ? info.enabled : enabled,
        port: currentPort,
        rotateToken: true,
      });
      setNotice(
        result?.rotated === false
          ? "配对令牌未变更"
          : "配对令牌已重置，重启 Moonlight 后生效；平板需要重新扫码配对。",
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const statusText = !bridge
    ? "当前为平板端页面，局域网开关仅在桌面端可用"
    : !info
      ? "正在读取局域网状态…"
      : info.running
        ? `服务运行中：检测到 ${info.urls.length} 个局域网地址`
        : info.enabled
          ? "已启用，但服务尚未运行，请重启 Moonlight"
          : "未启用局域网访问";

  return (
    <section className="settings-section lan-pairing" aria-label="平板伴读">
      <h3>
        <Tablet size={17} />平板伴读 · vivo Pad 5 Pro
      </h3>
      <p className="muted small">
        在桌面端开启后，让平板与电脑连接同一个 Wi-Fi，扫码或用配对链接即可打开全屏伴读工作台；论文库仍留在电脑本地。
      </p>

      {!bridge ? (
        <p className="muted small">
          当前页面运行在平板浏览器或 Web 预览中，局域网开关只能在桌面端 Moonlight 的「设置 → 平板伴读」中修改。
        </p>
      ) : (
        <>
          <label className="lan-toggle">
            <input
              type="checkbox"
              aria-label="局域网访问开关"
              checked={enabled}
              disabled={busy}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>开启局域网访问（moonlight-core --serve）</span>
          </label>
          <label>
            端口
            <input
              aria-label="端口"
              type="number"
              min={1024}
              max={65535}
              inputMode="numeric"
              value={port}
              disabled={busy}
              onChange={(event) => setPort(event.target.value)}
            />
          </label>
          <div className="actions">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>
              <Check size={14} />
              保存设置
            </button>
            <button className="btn" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw size={14} />
              刷新状态
            </button>
            <button className="btn" disabled={busy} onClick={() => void rotateToken()}>
              🔄 重置配对令牌
            </button>
          </div>
          <p className="muted small">端口、开关与配对令牌在 Moonlight 启动时绑定，修改后需重启软件才会生效。</p>

          <p className={`lan-status${info?.running ? " on" : ""}`} role="status">
            {info?.running ? <Wifi size={15} /> : <WifiOff size={15} />}
            {statusText}
          </p>
          {notice && <p className="lan-notice">{notice}</p>}

          {info && info.urls.length > 0 && (
            <ul className="lan-urls">
              {info.urls.map((url) => (
                <li className="lan-url" key={url}>
                  <div className="lan-url-code">
                    <code>{url}</code>
                  </div>
                  <button className="btn tiny" aria-label="复制配对链接" onClick={() => void copy(url)}>
                    {copied === url ? <Check size={13} /> : <Copy size={13} />}
                    {copied === url ? "已复制" : "复制链接"}
                  </button>
                  <div className="lan-qr-wrap">
                    <QrSvg value={url} size={168} label="平板配对二维码" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {info?.running && info.urls.length === 0 && (
            <p className="muted small">未检测到可用的局域网 IPv4 地址，请检查 Wi-Fi 或网线连接后重启服务。</p>
          )}
        </>
      )}

      <div className="lan-hint">
        <p>
          <strong>平板端提示：</strong>用 vivo Pad 5 Pro 的相机或 Chrome 扫码打开链接；在 Chrome 菜单中选择「添加到主屏幕 / 安装应用」，即可获得全屏、无地址栏的伴读界面。
        </p>
        <p className="muted small">配对链接包含访问令牌，请勿转发给他人。令牌保存在本机，正常重启后平板 PWA 仍可继续使用；仅当点击「🔄 重置配对令牌」后，才需要重新扫码配对。</p>
      </div>

      {error && <p role="alert" className="lan-error">{error}</p>}
    </section>
  );
}
