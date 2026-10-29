import { useEffect, useRef } from 'react';
import { ArrowRight, ClipboardPaste, FolderOpen, ShieldCheck, X } from 'lucide-react';

export function KubeconfigSourceDialog({ onClose, onFiles, onPaste }: { onClose: () => void; onFiles: () => void; onPaste: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('.kubeconfig-source-card')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="modal-backdrop"><section ref={dialog} className="kubeconfig-source-dialog" role="dialog" aria-modal="true" aria-label="Add kubeconfig" aria-describedby="kubeconfig-source-description">
    <header><div><h2>Add kubeconfig</h2><p id="kubeconfig-source-description">Choose how you want to connect your clusters.</p></div><button aria-label="Close add kubeconfig" onClick={onClose}><X size={18}/></button></header>
    <div className="kubeconfig-source-options">
      <button className="kubeconfig-source-card" aria-label="Add kubeconfig from filesystem" onClick={onFiles}><span className="kubeconfig-source-icon"><FolderOpen size={22}/></span><strong>From a file</strong><span className="kubeconfig-source-description">Select one or more kubeconfig files from your computer.</span><span className="kubeconfig-source-action">Browse files<ArrowRight size={15}/></span></button>
      <button className="kubeconfig-source-card" aria-label="Add kubeconfig from clipboard" onClick={onPaste}><span className="kubeconfig-source-icon"><ClipboardPaste size={22}/></span><strong>Paste kubeconfig</strong><span className="kubeconfig-source-description">Paste your kubeconfig YAML into the editor to add its contexts.</span><span className="kubeconfig-source-action">Open editor<ArrowRight size={15}/></span></button>
    </div>
    <p className="kubeconfig-source-hint">New contexts appear alongside your existing clusters.</p>
    <div className="kubeconfig-source-trust"><ShieldCheck size={16}/><p>Use trusted kubeconfigs. Authentication plugins can run commands on your computer.</p></div>
    <footer><button onClick={onClose}>Cancel</button></footer>
  </section></div>;
}
