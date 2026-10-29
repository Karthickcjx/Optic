import { useEffect, useRef, useState, type ReactNode } from 'react';

const storageKey = 'optic.navigatorWidth';
const minimum = 200;
const maximum = () => Math.max(minimum, Math.min(520, Math.floor(window.innerWidth * 0.5)));
const clamp = (value: number) => Math.max(minimum, Math.min(maximum(), value));
const initial = () => {
  try { const value = Number(localStorage.getItem(storageKey)); return value >= minimum && Number.isFinite(value) ? clamp(value) : 245; }
  catch { return 245; }
};

export function ResizableNavigator({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(initial);
  const drag = useRef<{ id: number; x: number; width: number } | undefined>(undefined);
  useEffect(() => {
    const resized = () => setWidth(value => clamp(value));
    window.addEventListener('resize', resized);
    return () => window.removeEventListener('resize', resized);
  }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, String(width)); } catch { /* Resizing also works without persistence. */ } }, [width]);
  return <div className="navigator-container" style={{ width }}>
    {children}
    <div className="navigator-resize" role="separator" aria-label="Resize Navigator" aria-orientation="vertical" aria-valuemin={minimum} aria-valuemax={maximum()} aria-valuenow={width} tabIndex={0} title="Drag to resize Navigator. Double-click to reset." onDoubleClick={() => setWidth(clamp(245))}
      onKeyDown={event => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') { event.preventDefault(); setWidth(value => clamp(value - step)); }
        if (event.key === 'ArrowRight') { event.preventDefault(); setWidth(value => clamp(value + step)); }
        if (event.key === 'Home') { event.preventDefault(); setWidth(minimum); }
        if (event.key === 'End') { event.preventDefault(); setWidth(maximum()); }
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const element = event.currentTarget;
        element.focus(); element.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, width };
      }} onPointerMove={event => { const start = drag.current; if (start && start.id === event.pointerId) setWidth(clamp(Math.round(start.width + event.clientX - start.x))); }}
      onPointerUp={event => { drag.current = undefined; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }}/>
  </div>;
}
