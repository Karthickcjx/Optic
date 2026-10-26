import { useId, useState, type SVGProps } from 'react';
import { createPortal } from 'react-dom';

export interface ChartSample { x: number; title: string; values: string[] }

/** Shared inspection for SVG charts: hover anywhere, or use arrow keys when focused. */
export function Chart({ samples, children, ...props }: SVGProps<SVGSVGElement> & { samples: ChartSample[] }) {
  const id = useId();
  const [cursor, setCursor] = useState<{ index: number; left: number; top: number }>();
  const sample = cursor && samples[cursor.index];
  const show = (index: number, left: number, top: number) => setCursor({ index, left, top });
  return <><svg {...props} tabIndex={samples.length ? 0 : undefined} aria-describedby={sample ? id : undefined}
    onPointerMove={event => {
      const svg = event.currentTarget, matrix = svg.getScreenCTM();
      if (!matrix || !samples.length) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      let index = 0;
      for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].x - point.x) < Math.abs(samples[index].x - point.x)) index = i;
      show(index, event.clientX, event.clientY);
    }} onPointerLeave={() => setCursor(undefined)} onBlur={() => setCursor(undefined)}
    onFocus={event => { if (samples.length) { const rect = event.currentTarget.getBoundingClientRect(); show(0, rect.left + rect.width / 2, rect.top + rect.height / 2); } }}
    onKeyDown={event => {
      if (event.key === 'Escape') { setCursor(undefined); return; }
      if (!samples.length || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? samples.length - 1 : Math.max(0, Math.min(samples.length - 1, (cursor?.index ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)));
      const rect = event.currentTarget.getBoundingClientRect(); show(index, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }}>{children}</svg>{sample && cursor && createPortal(<div id={id} role="tooltip" className="chart-tooltip" style={{
      left: Math.max(8, Math.min(cursor.left + 14, window.innerWidth - 328)),
      top: Math.max(8, Math.min(cursor.top + 14, window.innerHeight - 180)),
    }}><strong>{sample.title}</strong>{sample.values.map((value, index) => <div key={index}>{value}</div>)}</div>, document.body)}</>;
}
