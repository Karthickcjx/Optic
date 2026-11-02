export type DiffLine = { type: 'same' | 'add' | 'remove'; text: string; oldLine?: number; newLine?: number };
export type DiffSegment = { lines: DiffLine[] } | { skipped: number };

// Myers O(ND) line diff. Common prefix and suffix are trimmed first, so a typical
// edit costs only its own size. Returns undefined when more than maxEdits lines differ.
export function diffLines(before: string, after: string, maxEdits = 1000): DiffLine[] | undefined {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const middle = edits(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!middle) return undefined;
  const result: DiffLine[] = []; let oldLine = 0, newLine = 0;
  const push = (type: DiffLine['type'], text: string) => result.push({ type, text, ...(type !== 'add' ? { oldLine: ++oldLine } : {}), ...(type !== 'remove' ? { newLine: ++newLine } : {}) });
  for (let i = 0; i < start; i++) push('same', a[i]);
  for (const [type, text] of middle) push(type, text);
  for (let i = endA; i < a.length; i++) push('same', a[i]);
  return result;
}

function edits(a: string[], b: string[], max: number): [DiffLine['type'], string][] | undefined {
  const n = a.length, m = b.length, limit = Math.min(max, n + m), off = limit + 1;
  if (!n && !m) return [];
  const v = new Int32Array(2 * limit + 3), trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off);
    }
  }
  return undefined;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], off: number) {
  const out: [DiffLine['type'], string][] = []; let x = a.length, y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK], prevY = prevX - prevK;
    while (x > prevX && y > prevY) out.push(['same', a[--x]]), y--;
    if (d > 0) { if (x === prevX) out.push(['add', b[--y]]); else out.push(['remove', a[--x]]); }
  }
  return out.reverse();
}

// Groups a diff into changed regions with surrounding context; long unchanged runs collapse to a count.
export function diffSegments(lines: DiffLine[], context = 3): DiffSegment[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => { if (line.type !== 'same') for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true; });
  const segments: DiffSegment[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i; while (j < lines.length && keep[j] === keep[i]) j++;
    segments.push(keep[i] ? { lines: lines.slice(i, j) } : { skipped: j - i }); i = j;
  }
  return segments;
}
