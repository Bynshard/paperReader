import { useMemo } from "react";
import { createQrMatrix } from "./qrcode";

/**
 * Inline, zero-network QR renderer: one `<rect>` per dark module plus a white
 * background and a quiet zone of at least four modules on every side, which is
 * what phone cameras need to lock on.  No canvas, no external QR service.
 */
export default function QrSvg({
  value,
  size = 168,
  label,
  quietZone = 4,
}: {
  value: string;
  size?: number;
  label?: string;
  quietZone?: number;
}) {
  const matrix = useMemo(() => createQrMatrix(value), [value]);
  const count = matrix.length;
  const total = count + quietZone * 2;
  const modules = useMemo(() => {
    const cells: { x: number; y: number }[] = [];
    matrix.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) cells.push({ x: x + quietZone, y: y + quietZone });
      });
    });
    return cells;
  }, [matrix, quietZone]);

  return (
    <svg
      data-testid="lan-qr"
      className="lan-qr-svg"
      role="img"
      aria-label={label || "配对二维码"}
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={total} height={total} fill="#ffffff" />
      {modules.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} fill="#181a1f" />
      ))}
    </svg>
  );
}
