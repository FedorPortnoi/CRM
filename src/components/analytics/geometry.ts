// Arc maths shared by the report charts. SVG y grows downward, so every angle here is measured
// clockwise on screen: 0° points straight up, 90° points right.

export type Point = { x: number; y: number };

export function polarPoint(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/**
 * Stroked arc from `startDeg` to `endDeg` (clockwise). Returns an empty string for a zero-length
 * sweep so callers can skip rendering instead of emitting a degenerate path.
 */
export function describeArc(
  cx: number,
  cy: number,
  radius: number,
  startDeg: number,
  endDeg: number,
): string {
  const sweep = endDeg - startDeg;
  if (sweep <= 0) return '';

  // A full turn cannot be drawn as a single arc segment — the endpoints coincide.
  const safeEnd = sweep >= 360 ? startDeg + 359.99 : endDeg;
  const start = polarPoint(cx, cy, radius, startDeg);
  const end = polarPoint(cx, cy, radius, safeEnd);
  const largeArc = safeEnd - startDeg > 180 ? 1 : 0;

  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

/** Clamps a ratio into 0..1, treating a non-positive total as an empty chart. */
export function safeFraction(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max(value / total, 0), 1);
}
