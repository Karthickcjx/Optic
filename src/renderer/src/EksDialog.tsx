import { useStore } from './store';
import type { EksIdentity } from '../../shared/eks';
import { useEffect, useRef, useState } from 'react';
import { Cloud, RefreshCw, X } from 'lucide-react';
import { request } from './api';

export function EksDialog({ onClose, onAdded, initialProfile = '' }: { initialProfile?: string; onClose: () => void; onAdded: () => void }) {
  const [profiles, setProfiles] = useState<string[]>([]), [profile, setProfile] = useState(initialProfile);
  const [region, setRegion] = useState('us-east-1'), [names, setNames] = useState<string[]>([]);
  const [token, setToken] = useState<string>(), [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [identity, setIdentity] = useState<EksIdentity>();
  const [roleArn, setRoleArn] = useState('');
  const regionRequest = useRef(0);
  const [added, setAdded] = useState<string[]>([]);
  const dialog = useRef<HTMLElement>(null);
  async function loadProfiles() {
    setBusy(true); setError('');
    try { setProfiles(await request('eks:profiles', undefined)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  useEffect(() => {
    void loadProfiles(); void useProfileRegion(initialProfile); const previous = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); }
      if (e.key === 'Tab') { const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') ?? []); const first = controls[0], last = controls.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    };
    document.addEventListener('keydown', key, true); return () => { document.removeEventListener('keydown', key, true); previous?.focus(); };
  }, []);
  async function useProfileRegion(selected: string) {
    const generation = ++regionRequest.current;
    try { const value = await request('eks:region', { profile: selected }); if (generation === regionRequest.current && value) setRegion(value); } catch { /* Manual region remains available. */ }
  }
  async function verify() {
    setBusy(true); setError(''); setIdentity(undefined);
    try { setIdentity(await request('eks:identity', { profile, region })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function signIn(action: 'login' | 'configure') {
    useStore.getState().openTab({ type: 'terminal', title: action === 'configure' ? 'Configure AWS SSO' : `AWS SSO: ${profile || 'default'}`, options: { cols: 100, rows: 24, awsLogin: { action, profile } } });
    onClose();
  }
  function reset() { setIdentity(undefined); setNames([]); setToken(undefined); setSearched(false); setAdded([]); setError(''); setNotice(''); }
  async function discover(more = false) {
    setBusy(true); setError(''); setNotice('');
    if (!more) { setNames([]); setToken(undefined); setSearched(false); }
    try { const page = await request('eks:list', { profile, region, ...(more ? { nextToken: token } : {}) }); setNames(old => [...new Set([...(more ? old : []), ...page.names])].sort()); setToken(page.nextToken); setSearched(true); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function add(name: string) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await request('eks:import', { profile, region, name, ...(roleArn.trim() ? { roleArn: roleArn.trim() } : {}) }); setAdded(old => [...old, name]); setNotice(`${name} added to Navigator. Kubernetes access still depends on your IAM identity, cluster access entries and network. ${result.warnings.length ? 'Some kubeconfig sources could not be loaded.' : ''}`); onAdded(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop"><section ref={dialog} className="eks-dialog" role="dialog" aria-modal="true" aria-label="Discover AWS EKS clusters"><header><div><Cloud size={23}/><h2>AWS EKS</h2></div><button aria-label="Close EKS discovery" onClick={onClose}><X size={18}/></button></header><p>Discover clusters using your existing AWS CLI credentials. Select a profile and region to get started.</p>
    <div className="eks-filters"><label>AWS profile<select disabled={busy} value={profile} onChange={e => { setProfile(e.target.value); reset(); void useProfileRegion(e.target.value); }}><option value="">Default credential chain</option>{profiles.map(p => <option key={p}>{p}</option>)}</select></label><label>AWS region<input disabled={busy} value={region} placeholder="us-east-1" onChange={e => { ++regionRequest.current; setRegion(e.target.value.trim()); reset(); }}/></label><button disabled={busy} title="Refresh AWS profiles" aria-label="Refresh AWS profiles" onClick={() => void loadProfiles()}><RefreshCw size={16}/></button><button className="primary" disabled={busy || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)} onClick={() => void discover()}>Discover clusters</button></div>
    <div className="eks-identity"><button disabled={busy || !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)} onClick={() => void verify()}>Verify AWS identity</button>{identity ? <span><strong>Account {identity.account}</strong><small>{identity.arn}</small></span> : <span>Verify which AWS account this profile uses before adding clusters.</span>}</div>
    <div className="eks-sso-actions"><button disabled={busy} onClick={() => signIn('login')}>Sign in with SSO</button><button disabled={busy} onClick={() => signIn('configure')}>Configure SSO profile</button><p>Opens the AWS wizard in Optic's terminal. Complete browser sign-in, choose your account and role, then return here and refresh profiles. Configuration updates your AWS CLI profile.</p></div>
    <details className="eks-advanced"><summary>Advanced authentication</summary><label>Authentication role ARN (optional)<input disabled={busy} value={roleArn} placeholder="arn:aws:iam::123456789012:role/EksAccess" onChange={e => { setRoleArn(e.target.value); setAdded([]); }}/></label><p>The role is assumed when authenticating to Kubernetes. Discovery still uses the selected profile; configure a role-based AWS profile for cross-account discovery.</p></details>
    {busy && <p role="status">Contacting AWS…</p>}{error && <div className="inline-error" role="alert">{error}</div>}{notice && <p className="eks-notice" role="status">{notice}</p>}
    <div className="eks-results">{names.map(name => <div key={name}><span><strong>{name}</strong><small>{region} · {profile || 'Default credentials'}</small></span><button disabled={busy || added.includes(name)} onClick={() => void add(name)}>{added.includes(name) ? 'Added' : 'Add cluster'}</button></div>)}{searched && !names.length && <p>No EKS clusters found for this profile and region.</p>}{!searched && !busy && !error && <p>Your clusters will appear here.</p>}</div>
    {token && <button disabled={busy} onClick={() => void discover(true)}>Load more clusters</button>}
    <footer><p>Requires AWS CLI v2 and permission to list and describe EKS clusters. For SSO profiles, sign in with <code>aws sso login --profile &lt;profile&gt;</code> in your terminal. Optic saves a separate kubeconfig with AWS token authentication; your existing kubeconfig stays unchanged.</p><button onClick={onClose}>Done</button></footer>
  </section></div>;
}
