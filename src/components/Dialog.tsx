import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from '@phosphor-icons/react/X';

export function Dialog({ title, onClose, children, className = '', dismissible = true }: { title: string; onClose: () => void; children: ReactNode; className?: string; dismissible?: boolean }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [portalTarget, setPortalTarget] = useState<Element>(() => document.fullscreenElement ?? document.body);
  const closeRef = useRef(onClose);
  closeRef.current = dismissible ? onClose : () => {};
  useEffect(() => {
    const updateTarget = () => setPortalTarget(document.fullscreenElement ?? document.body);
    document.addEventListener('fullscreenchange', updateTarget);
    return () => document.removeEventListener('fullscreenchange', updateTarget);
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.querySelector<HTMLElement>('input, button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !element) return;
      const items = [...element.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [portalTarget]);
  return createPortal(<div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div ref={dialog} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label="关闭" disabled={!dismissible} onClick={onClose}><X size={22} /></button></div>
      {children}
    </div>
  </div>, portalTarget);
}
