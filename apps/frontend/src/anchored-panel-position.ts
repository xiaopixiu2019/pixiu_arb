interface Rectangle { left: number; top: number; bottom: number }
interface Viewport { left: number; top: number; width: number; height: number }

/** Keep an interactive panel inside the visual viewport, including browser zoom and soft keyboards. */
export function anchoredPanelPosition(anchor: Rectangle, panelHeight: number, viewport: Viewport) {
  const gutter = 12, gap = 6;
  const width = Math.min(288, Math.max(0, viewport.width - gutter * 2));
  const maxHeight = Math.max(0, viewport.height - gutter * 2);
  const height = Math.min(panelHeight, maxHeight);
  const left = Math.max(viewport.left + gutter, Math.min(anchor.left, viewport.left + viewport.width - gutter - width));
  const below = anchor.bottom + gap;
  const preferred = below + height <= viewport.top + viewport.height - gutter ? below : anchor.top - gap - height;
  const top = Math.max(viewport.top + gutter, Math.min(preferred, viewport.top + viewport.height - gutter - height));
  return { left, top, width, maxHeight };
}
