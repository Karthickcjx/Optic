import { useEffect, useState } from 'react';
import type { Resource, ResourceKind } from '../../shared/protocol';
import type { CustomType } from '../../shared/catalog';
import { closeStream, request } from './api';
export function useResources(clusterId: string, kind: ResourceKind, namespace?: string, custom?: CustomType) {
  const [items, setItems] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setItems([]); setError(undefined);
    if (!clusterId) { setLoading(false); return; }
    let active = true;
    const id = crypto.randomUUID(); setLoading(true);
    const unsubscribe = window.desktop.subscribe(event => {
      if (!active || event.id !== id) return;
      if (event.type === 'resources') { setItems(event.items); setLoading(false); setError(undefined); }
      if (event.type === 'error') { setError(event.error.message); setLoading(false); }
    });
    void request('resources:watch', { id, clusterId, kind, namespace: namespace || undefined, custom }).catch(e => { if (active) { setError(e.message); setLoading(false); } });
    return () => { active = false; unsubscribe(); closeStream(id); };
  }, [clusterId, kind, namespace, revision, custom?.apiVersion, custom?.plural]);
  return { items, loading, error, refresh: () => setRevision(v => v + 1) };
}
