import { useEffect, useState } from 'react';
import { Network, RefreshCw, Square } from 'lucide-react';
import { closeStream, request } from './api';
import type { DockTab } from './store';
import type { Requests } from '../../shared/protocol';

export function ForwardPane({ tab, visible }: { tab: DockTab; visible: boolean }) {
  const [revision, setRevision] = useState(0), [stopped, setStopped] = useState(false);
  const [port, setPort] = useState<number>(), [error, setError] = useState(''), [ended, setEnded] = useState(false);
  const options = tab.options as Omit<Requests['forward:start']['input'], 'id'>;
  useEffect(() => {
    setPort(undefined); setError(''); setEnded(false);
    if (stopped) return;
    const id = crypto.randomUUID(); let active = true;
    const unsubscribe = window.desktop.subscribe(event => {
      if (!active || event.id !== id) return;
      if (event.type === 'error') setError(event.error.message);
      if (event.type === 'end') setEnded(true);
    });
    void request('forward:start', { ...options, id }).then(result => { if (active) setPort(result.localPort); else closeStream(id); }).catch(e => { if (active) { setError(e.message); setEnded(true); } });
    return () => { active = false; unsubscribe(); closeStream(id); };
  }, [tab, revision, stopped]);
  return <div className="forward-pane" style={{ display: visible ? 'block' : 'none' }}><h3><Network size={18}/>Port forwarding: {options.namespace}/{options.name}</h3><p>{stopped ? 'Stopped' : ended ? 'Disconnected' : port ? 'Listening on this computer' : 'Starting kubectl port-forward...'}</p>{port && !stopped && !ended && <code>127.0.0.1:{port} → {options.kind}/{options.name}:{options.remotePort}</code>}{error && <div className="inline-error">{error}</div>}<div><button disabled={stopped || ended} onClick={() => setStopped(true)}><Square size={13}/>Stop forwarding</button><button onClick={() => { setStopped(false); setRevision(v => v + 1); }}><RefreshCw size={13}/>Restart forwarding</button></div><small>The listener binds only to 127.0.0.1. Closing this tab stops the process.</small></div>;
}
