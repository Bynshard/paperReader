import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

type Placement = "below" | "above" | "auto";

type Props = {
  /** Viewport coordinates of the anchor (usually the centre of the trigger). */
  x: number;
  y: number;
  placement?: Placement;
  gap?: number;
  /** Keep the layer below this viewport Y (e.g. under a fixed header). */
  boundsTop?: number;
  className?: string;
  label?: string;
  /** Element that toggles the layer; pointerdowns inside it are not treated as "outside". */
  ignore?: RefObject<HTMLElement | null>;
  onClose?: () => void;
  children: ReactNode;
};

/** Viewport-clamped floating surface (menus, popovers, selection toolbars). */
export default function FloatingLayer({ x, y, placement = "auto", gap = 8, boundsTop = 10, className = "", label, ignore, onClose, children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [position, setPosition] = useState({ left: x, top: y });
  const [side, setSide] = useState<Exclude<Placement, "auto">>(placement === "above" ? "above" : "below");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const pad = 10;
    const topBound = Math.max(pad, boundsTop);
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    let place: Exclude<Placement, "auto"> = placement === "auto" ? (y > vh * 0.62 ? "above" : "below") : placement;
    let top = place === "below" ? y + gap : y - rect.height - gap;
    if (place === "below" && top + rect.height > vh - pad && y - rect.height - gap > topBound) { place = "above"; top = y - rect.height - gap; }
    if (place === "above" && top < topBound) { place = "below"; top = y + gap; }
    const left = Math.min(Math.max(pad, x - rect.width / 2), Math.max(pad, vw - rect.width - pad));
    top = Math.min(Math.max(topBound, top), Math.max(topBound, vh - rect.height - pad));
    setSide(place);
    setPosition({ left, top });
    setReady(true);
  }, [x, y, placement, gap, boundsTop, children]);

  useEffect(() => {
    if (!onClose) return;
    const down = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (ignore?.current?.contains(target)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose, ignore]);

  return createPortal(
    <div
      ref={ref}
      className={`floating-layer ${className}`}
      data-side={side}
      role="dialog"
      aria-label={label}
      style={{ left: position.left, top: position.top, visibility: ready ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
