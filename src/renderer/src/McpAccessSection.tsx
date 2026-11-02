import { useEffect, useState } from 'react';
import type { McpAccess } from '../../shared/mcp';
import { request } from './api';

// Cluster settings section: opt a kubeconfig context in to (or out of) Optic's read-only MCP server.
export function McpAccessSection({ clusterId, clusterName }: { clusterId: string; clusterName: string }) {
  const [access, setAccess] = useState<McpAccess>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  useEffect(() => { let active = true; setAccess(undefined); setError(''); void request('mcp:access', { clusterId }).then(value => { if (active) setAccess(value); }, e => { if (active) setError((e as Error).message); }); return () => { active = false; }; }, [clusterId]);
  const change = async (approved: boolean) => {
    setBusy(true); setError('');
    try { setAccess(await request('mcp:access-set', { clusterId, approved })); setConfirm(false); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const credentialCommand = access?.auth.command && [access.auth.command, ...(access.auth.args ?? [])].join(' ');
  const config = access && JSON.stringify({ mcpServers: { 'optic-kubernetes': { command: access.launch.command, args: access.launch.args } } }, null, 2);
  return <>
    <p>Let MCP-compatible AI clients, such as Claude Code, read this cluster through Optic's read-only MCP server. The server runs without the Optic window. It cannot change the cluster, never returns Secret values, and Kubernetes RBAC still applies.</p>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {!access && !error && <p className="muted">Loading…</p>}
    {access && <>
      <dl className="mcp-access">
        <dt>Status</dt><dd role="status">{!access.approved ? 'Not approved' : access.stale ? 'Needs re-approval: the kubeconfig changed (server, CA or credential command)' : `Approved ${access.approvedAt ? new Date(access.approvedAt).toLocaleString() : ''}`}</dd>
        <dt>Authentication</dt><dd>{access.auth.type}{credentialCommand && <> · the MCP server runs <code>{credentialCommand}</code> to get credentials</>}</dd>
      </dl>
      <div className="mcp-access-actions">
        {(!access.approved || access.stale) && <button className="primary" disabled={busy} onClick={() => setConfirm(true)}>{access.stale ? 'Re-approve…' : 'Approve AI access…'}</button>}
        {access.approved && <button disabled={busy} onClick={() => void change(false)}>Revoke access</button>}
      </div>
      <h3>Connect an MCP client</h3>
      <p>Claude Code:</p>
      <pre className="mcp-config">{`claude mcp add optic-kubernetes -- "${access.launch.command}" ${access.launch.args.join(' ')}`}</pre>
      <p>Other clients (JSON configuration):</p>
      <pre className="mcp-config">{config}</pre>
      <p className="muted">Approval covers this context only. Changing its server, certificate authority or credential command in the kubeconfig suspends access until you approve again.</p>
    </>}
    {confirm && access && <div className="modal-backdrop"><section className="confirm-modal" role="dialog" aria-label="Approve AI access">
      <h2>Allow AI clients to read {clusterName}?</h2>
      <p>MCP clients on this computer will be able to list and read resources, events and pod logs in this cluster, within your Kubernetes permissions. Secret values are never returned; other values that look like credentials are redacted on a best-effort basis.</p>
      {credentialCommand && <p>To authenticate, the MCP server will run: <code>{credentialCommand}</code></p>}
      <footer><button disabled={busy} onClick={() => setConfirm(false)}>Cancel</button><button className="primary" disabled={busy} onClick={() => void change(true)}>Approve</button></footer>
    </section></div>}
  </>;
}
