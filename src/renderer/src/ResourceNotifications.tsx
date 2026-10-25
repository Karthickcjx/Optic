import { CheckCircle2, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useResourceOperations } from './resource-operations';
import { useStore } from './store';

export function ResourceNotifications() {
  const { operations, dismiss } = useResourceOperations();
  const navigate = useStore(s => s.navigate), setNamespace = useStore(s => s.setNamespace);
  return <>{operations.map(o => <section key={o.id} className={`resource-notification helm-notification ${o.status}`} role="status">
    <header>{o.status === 'running' ? <LoaderCircle size={16} className="spin"/> : o.status === 'succeeded' ? <CheckCircle2 size={16}/> : <TriangleAlert size={16}/>}<strong>{o.title}</strong>{o.status !== 'running' && <button aria-label={`Dismiss ${o.title}`} onClick={() => dismiss(o.id)}><X size={14}/></button>}</header>
    <p>{o.message}</p><small>{o.target.namespace ? `${o.target.namespace}/` : ''}{o.target.name}</small><button onClick={() => { navigate(o.target.kind, o.target.clusterId); setNamespace(o.target.namespace ?? ''); }}>View resources</button>
  </section>)}</>;
}
