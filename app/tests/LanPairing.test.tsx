import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LanPairing from "../src/LanPairing";

const PAIR_URL = "http://192.168.1.23:8765/?token=0123456789abcdef0123456789abcdef";

const bridge = { lanInfo: vi.fn(), configureLan: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { moonlight: unknown }).moonlight = bridge;
  bridge.lanInfo.mockResolvedValue({ enabled: true, port: 8765, running: true, urls: [PAIR_URL] });
  bridge.configureLan.mockResolvedValue({ restart_required: true });
});

afterEach(() => {
  delete (window as unknown as { moonlight?: unknown }).moonlight;
});

describe("tablet pairing card", () => {
  it("shows the pairing URL, running status and an offline SVG QR with a quiet zone", async () => {
    render(<LanPairing />);
    expect(await screen.findByText(PAIR_URL)).toBeTruthy();
    expect(screen.getByText(/服务运行中/)).toBeTruthy();

    const qr = screen.getByTestId("lan-qr");
    expect(qr.getAttribute("shape-rendering")).toBe("crispEdges");
    const rects = Array.from(qr.querySelectorAll("rect"));
    // One background rect + one rect per dark module.
    expect(rects.length).toBeGreaterThan(1);
    expect(rects[0]!.getAttribute("fill")).toBe("#ffffff");

    const viewBox = (qr.getAttribute("viewBox") || "").split(/\s+/).map(Number);
    expect(viewBox).toHaveLength(4);
    const size = viewBox[2]!;
    const modules = rects.slice(1).map((rect) => ({
      x: Number(rect.getAttribute("x")),
      y: Number(rect.getAttribute("y")),
    }));
    expect(modules.length).toBeGreaterThan(0);
    for (const module of modules) {
      // Quiet zone of at least 4 modules on every side.
      expect(module.x).toBeGreaterThanOrEqual(4);
      expect(module.y).toBeGreaterThanOrEqual(4);
      expect(module.x).toBeLessThanOrEqual(size - 5);
      expect(module.y).toBeLessThanOrEqual(size - 5);
    }
  });

  it("copies the pairing URL to the clipboard and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<LanPairing />);
    await screen.findByText(PAIR_URL);

    fireEvent.click(screen.getByRole("button", { name: "复制配对链接" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PAIR_URL));
    expect(await screen.findByText("已复制")).toBeTruthy();
  });

  it("saves the enabled flag and port and reports restart-to-apply", async () => {
    render(<LanPairing />);
    const toggle = (await screen.findByLabelText("局域网访问开关")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "9000" } });
    fireEvent.click(screen.getByRole("button", { name: /保存设置/ }));

    await waitFor(() => expect(bridge.configureLan).toHaveBeenCalledWith({ enabled: false, port: 9000 }));
    expect(await screen.findByText(/重启 Moonlight 后生效/)).toBeTruthy();
  });

  it("rejects an out-of-range port without touching the bridge", async () => {
    render(<LanPairing />);
    await screen.findByText(PAIR_URL);
    fireEvent.change(screen.getByLabelText("端口"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: /保存设置/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("端口需为 1024–65535 之间的整数");
    expect(bridge.configureLan).not.toHaveBeenCalled();
  });

  it("rotates the pairing token on demand and warns that re-pairing is required", async () => {
    bridge.configureLan.mockResolvedValue({ restart_required: true, rotated: true });
    render(<LanPairing />);
    await screen.findByText(PAIR_URL);

    fireEvent.click(screen.getByRole("button", { name: /重置配对令牌/ }));

    await waitFor(() =>
      expect(bridge.configureLan).toHaveBeenCalledWith({ enabled: true, port: 8765, rotateToken: true }),
    );
    expect(await screen.findByText(/配对令牌已重置，重启 Moonlight 后生效/)).toBeTruthy();
    // A normal save must not rotate the persisted token.
    expect(bridge.configureLan).toHaveBeenCalledTimes(1);
  });

  it("explains that the switch is desktop-only when the preload bridge is absent", async () => {
    delete (window as unknown as { moonlight?: unknown }).moonlight;
    render(<LanPairing />);
    expect(await screen.findByText(/只能在桌面端/)).toBeTruthy();
  });
});
