import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from './i18n.js';
import { useDialogFocus } from './route-shared.js';
import './asset-workspace.css';

/** One mounted view moves between page and dialog, preserving form state and read subscriptions. */
export function AssetWorkspace({ open, pageHost, children, onClose, onExpand }: {
  open: boolean; pageHost: RefObject<HTMLDivElement | null>; children: ReactNode; onClose: () => void; onExpand: () => void;
}) {
  const { language } = useLanguage(), zh = language === 'zh';
  const [host] = useState(() => document.createElement('div'));
  const [body] = useState(() => ({ current: null as HTMLDivElement | null }));
  const nestedDialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .some((node) => !node.classList.contains('asset-modal') && node.getClientRects().length > 0);
  const close = () => { if (!nestedDialog()) onClose(); };
  const dialog = useDialogFocus(open, close, () => !nestedDialog());
  useLayoutEffect(() => {
    const target = open ? body.current : pageHost.current;
    target?.appendChild(host);
    return () => host.remove();
  }, [host, open, pageHost, body]);
  return <>
    {open && <div className="asset-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="asset-modal" role="dialog" aria-modal="true" aria-label={zh ? '资金状况' : 'Asset overview'} ref={dialog} tabIndex={-1}>
        <header><h2>{zh ? '资金状况' : 'Asset overview'}</h2><div>
          <button type="button" onClick={() => { if (!nestedDialog()) onExpand(); }}>{zh ? '展开完整页 ↗' : 'Open full page ↗'}</button>
          <button type="button" data-dialog-autofocus aria-label={zh ? '关闭资金状况' : 'Close asset overview'} onClick={close}>×</button>
        </div></header><div className="asset-modal-body" ref={(node) => { body.current = node; }} />
      </section>
    </div>}
    {createPortal(children, host)}
  </>;
}
