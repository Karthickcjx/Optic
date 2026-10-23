import type { WebContents } from 'electron';
import type { StreamEvent } from '../shared/protocol';
import { AppError, fault } from './errors';

interface Session { clusterId?: string; owner: WebContents; dispose: () => void; write?: (data: string) => void; resize?: (cols: number, rows: number) => void; ack?: (seq: number) => void }
export class Streams {
  private sessions = new Map<string, Session>();
  add(id: string, session: Session) {
    if (this.sessions.has(id)) throw new AppError('DUPLICATE_STREAM', 'Stream ID is already in use.');
    if ([...this.sessions.values()].filter(s => s.owner.id === session.owner.id).length >= 24) throw new AppError('STREAM_LIMIT', 'Close a stream before opening another.');
    this.sessions.set(id, session);
  }
  get(id: string, owner: WebContents) {
    const session = this.sessions.get(id);
    if (!session || session.owner.id !== owner.id) throw new AppError('UNKNOWN_STREAM', 'Stream is closed or belongs to another window.');
    return session;
  }
  emit(id: string, event: StreamEvent) { const s = this.sessions.get(id); if (s && !s.owner.isDestroyed()) s.owner.send('stream:event', event); }
  error(id: string, error: unknown) { this.emit(id, { id, type: 'error', error: fault(error) }); }
  end(id: string, exitCode?: number) { this.emit(id, { id, type: 'end', exitCode }); this.close(id); }
  close(id: string) { const s = this.sessions.get(id); this.sessions.delete(id); s?.dispose(); }
  closeOwner(owner: WebContents) { for (const [id, s] of this.sessions) if (s.owner.id === owner.id) this.close(id); }
  closeCluster(clusterId: string) { for (const [id, s] of this.sessions) if (s.clusterId === clusterId) this.close(id); }
  closeAll() { for (const id of this.sessions.keys()) this.close(id); }
}
