import { diffLines, diffSegments } from '../../shared/yaml-diff';

// Unified view of unsaved edits against the YAML loaded from the cluster.
export function YamlDiff({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  if (!lines) return <p className="muted">Too many lines changed to show a comparison. Review the YAML directly or revert it.</p>;
  return <div className="yaml-diff" role="table" aria-label="YAML changes">{diffSegments(lines).map((segment, i) => 'skipped' in segment
    ? <div key={i} className="diff-skip" role="row"><span role="cell">{segment.skipped} unchanged line{segment.skipped === 1 ? '' : 's'}</span></div>
    : segment.lines.map((line, j) => <div key={`${i}:${j}`} className={`diff-line ${line.type}`} role="row">
        <span role="cell" className="diff-number">{line.oldLine ?? ''}</span><span role="cell" className="diff-number">{line.newLine ?? ''}</span>
        <span role="cell" className="diff-marker" aria-label={line.type === 'add' ? 'Added' : line.type === 'remove' ? 'Removed' : undefined}>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
        <span role="cell" className="diff-text">{line.text}</span>
      </div>))}</div>;
}
