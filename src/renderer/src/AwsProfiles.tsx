import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, ChevronDown, ChevronRight, RefreshCw, Settings2, UserRound } from 'lucide-react';
import { request } from './api';

export function AwsProfiles({ filter, onOpen }: { filter: string; onOpen: (profile: string) => void }) {
  const [open, setOpen] = useState(() => localStorage.getItem('optic.aws.expanded') === 'true');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    setBusy(true); setError('');
    try { setProfiles(await request('eks:profiles', undefined)); }
    catch (e) { setError((e as Error).message); }
    finally { loading.current = false; setBusy(false); }
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => {
    const focus = () => { if (open) void refresh(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [open, refresh]);
  const query = filter.trim().toLowerCase();
  // The implicit CLI default remains usable in the discovery dialog, not as a sidebar connection.
  const named = profiles.filter(p => p !== 'default');
  const shown = named.filter(p => !query || p.toLowerCase().includes(query) || 'aws eks'.includes(query));
  function expand(next: boolean) {
    setOpen(next); localStorage.setItem('optic.aws.expanded', String(next));
  }
  if (query && !shown.length && !'aws eks manage connections'.includes(query)) return null;
  return <div className="aws-profile-navigation">
    <div className="aws-profile-heading">
      <button className="tree-group" aria-expanded={open} onClick={() => expand(!open)}>
        {open ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<Cloud size={14}/><span>AWS EKS</span>
      </button>
      <button title="Refresh AWS profiles" aria-label="Refresh navigator AWS profiles" disabled={busy} onClick={() => { if (!open) expand(true); else void refresh(); }}><RefreshCw size={13}/></button>
    </div>
    {(open || query) && <div className="tree-group-children">
      {busy && <small role="status">Loading profiles...</small>}
      {error && <p role="alert" className="aws-profile-error">{error}</p>}
      {shown.map(profile => <button key={profile} className="tree-leaf" title={`Discover EKS clusters with ${profile}`} onClick={() => onOpen(profile)}><UserRound size={14}/><span>{profile}</span></button>)}
      <button className="tree-leaf" title="Manage AWS connections" onClick={() => onOpen('')}><Settings2 size={14}/><span>Manage AWS connections</span></button>
    </div>}
  </div>;
}
