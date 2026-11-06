/** D：审计台 diff 行窗口化（纯函数，便于单测与测时）。 */

export interface DiffWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
}

export function computeDiffWindow(
  totalLines: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = 18,
  overscan = 8,
): DiffWindow {
  const total = Math.max(0, totalLines);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, start + visibleCount + overscan * 2);
  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight: total * rowHeight,
  };
}
