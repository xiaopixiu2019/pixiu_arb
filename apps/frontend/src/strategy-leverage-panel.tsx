import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { anchoredPanelPosition } from './anchored-panel-position.js';

export function StrategyLeveragePanel({ anchor, onClose, children, label }: {
  anchor: RefObject<HTMLButtonElement | null>; onClose: () => void; children: ReactNode; label: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof anchoredPanelPosition> | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      if (!anchor.current || !panel.current) return;
      const vv = window.visualViewport;
      const viewport = { left: vv?.offsetLeft ?? 0, top: vv?.offsetTop ?? 0, width: vv?.width ?? innerWidth, height: vv?.height ?? innerHeight };
      setPosition(anchoredPanelPosition(anchor.current.getBoundingClientRect(), panel.current.getBoundingClientRect().height, viewport));
    };
    update();
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update); window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update); window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [anchor]);
  usePanelFocus(panel, position !== null);
  usePanelDismiss(panel, anchor, onClose);
  return createPortal(<div ref={panel} className="leverage-popover strategy-leverage-popover" role="dialog" aria-label={label}
    style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>{children}</div>, document.body);
}
function usePanelFocus(panel: RefObject<HTMLDivElement | null>, positioned: boolean) {
  useLayoutEffect(() => {
    if (positioned) panel.current?.querySelector<HTMLInputElement>('input[type="number"]')?.focus({ preventScroll: true });
  }, [panel, positioned]);
}

function usePanelDismiss(panel: RefObject<HTMLDivElement | null>, anchor: RefObject<HTMLButtonElement | null>, close: () => void) {
  useLayoutEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchor.current?.contains(event.target as Node)) close();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); anchor.current?.focus(); }
      if (event.key !== 'Tab' || !panel.current) return;
      const controls = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard); };
  }, [anchor, close, panel]);
}
