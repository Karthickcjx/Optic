import { CheckCircle2, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { useHelmOperations } from './helm-operations';
import { useStore } from './store';
import { ResourceNotifications } from './ResourceNotifications';

export function HelmNotifications() {
  const { operations, dismiss } = useHelmOperations();
  const navigate = useStore(s => s.navigate);
  return <aside className="helm-notifications" aria-label="Background operations" aria-live="polite">{operations.map(operation => <section key={operation.id} className={`helm-notification ${operation.status}`} role="status">
    <header>{operation.status === 'running' ? <LoaderCircle size={16} className="spin"/> : operation.status === 'succeeded' ? <CheckCircle2 size={16}/> : <TriangleAlert size={16}/>}<strong>{operation.title}</strong>{operation.status !== 'running' && <button aria-label={`Dismiss ${operation.title}`} onClick={() => dismiss(operation.id)}><X size={14}/></button>}</header>
    <p>{operation.message}</p><button onClick={() => navigate('helm-releases', operation.clusterId)}>View releases</button>
  </section>)}<ResourceNotifications/></aside>;
}
