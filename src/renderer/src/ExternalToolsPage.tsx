import { useEffect, useState } from 'react';
import { TerminalSquare, RefreshCw } from 'lucide-react';
import { externalTools, type ExternalToolState, type ExternalToolSettings } from '../../shared/external-tools';
import { request } from './api';
import { useStore } from './store';

export function ExternalToolsPage() {
  const [state, setState] = useState<ExternalToolState>();
  const [draft, setDraft] = useState<ExternalToolSettings>();
  const [args, setArgs] = useState('[]');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function refresh() {
    setBusy(true); setError('');
    try { const next = await request('tools:get', undefined); setState(next); if (!draft) { setDraft(next.settings); setArgs(JSON.stringify(next.settings.args)); } }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function save(launch = false) {
    if (!draft) return;
    setBusy(true); setError(''); setNotice('');
    try {
      let parsed: unknown; try { parsed = draft.selected === 'custom' ? JSON.parse(args) : draft.args; } catch { throw new Error('Arguments must be a JSON array, for example ["--help"].'); }
      if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) throw new Error('Arguments must be an array of strings.');
      const next = await request('tools:save', { ...draft, args: parsed }); setState(next); setDraft(next.settings); setNotice('Preferences saved.');
      if (launch) useStore.getState().openTab({ type: 'terminal', title: draft.selected === 'custom' ? 'Custom tool' : externalTools.find(t => t.id === draft.selected)?.name || 'External tool', options: { externalTool: true, cols: 100, rows: 24 } });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const available = draft?.selected === 'custom' || state?.detected.some(t => t.id === draft?.selected && t.path);
  return <section className="external-tools-page"><header><h1>External Tools</h1><p>Choose a CLI assistant to launch in your workspace terminal.</p></header><div className="external-tools-toolbar"><span>{state?.detected.filter(t => t.path).length ?? 0} of {externalTools.length} detected</span><button disabled={busy} onClick={() => void refresh()}><RefreshCw size={15}/>Refresh</button></div>
    {draft && <fieldset className="external-tool-list" disabled={busy}><legend className="sr-only">Preferred external tool</legend>{externalTools.map(tool => {
      const path = state?.detected.find(t => t.id === tool.id)?.path;
      return <label key={tool.id} className={draft.selected === tool.id ? 'selected' : ''}><input type="radio" name="external-tool" checked={draft.selected === tool.id} onChange={() => { setDraft({ ...draft, selected: tool.id }); setNotice(''); }}/><TerminalSquare size={22}/><span><strong>{tool.name}</strong><small>{path || `Command “${tool.command}” was not found on PATH. Install it from its publisher, restart Optic, then refresh.`}</small></span><em>{path ? 'Detected' : 'Not installed'}</em></label>;
    })}<label className={draft.selected === 'custom' ? 'selected' : ''}><input type="radio" name="external-tool" checked={draft.selected === 'custom'} onChange={() => setDraft({ ...draft, selected: 'custom' })}/><TerminalSquare size={22}/><span><strong>Custom</strong><small>Run your own executable with optional arguments.</small></span></label><label className={draft.selected === 'none' ? 'selected' : ''}><input type="radio" name="external-tool" checked={draft.selected === 'none'} onChange={() => setDraft({ ...draft, selected: 'none' })}/><span><strong>No AI tool</strong><small>Disable external tool launching.</small></span></label></fieldset>}
    {draft?.selected === 'custom' && <div className="external-tool-custom"><label>Executable path or command<input value={draft.executable} placeholder="C:\\Tools\\assistant.exe" onChange={e => setDraft({ ...draft, executable: e.target.value })}/></label><label>Arguments (JSON array)<input value={args} onChange={e => setArgs(e.target.value)} placeholder={'["--help"]'}/></label></div>}
    <p className="external-tool-note">Tools run locally with your user permissions and their own sign-in. Optic does not automatically send resource contents or attach a cluster kubeconfig. Tools can access files and credentials available to your user account.</p>
    {error && <div role="alert" className="warning">{error}</div>}{notice && <p role="status">{notice}</p>}<footer><button disabled={busy || !draft} onClick={() => void save()}>Save preferences</button><button className="primary" disabled={busy || !available} onClick={() => void save(true)}><TerminalSquare size={16}/>Save and launch</button></footer>
  </section>;
}
