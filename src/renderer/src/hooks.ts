import { useEffect, useState } from 'react';
import type { Resource, ResourceKind } from '../../shared/protocol';
import type { CustomType } from '../../shared/catalog';
import { closeStream, request } from './api';
export function useResources(clusterId: string, kind: ResourceKind, namespace?: string, custom?: CustomType, fieldSelector?: string) {
  const [items, setItems] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>(), [errorCode, setErrorCode] = useState<string>();
  const [revision, setRevision] = useState(0);
  // The watch delivers changes made by actions, so finishing one must not tear down and re-list every table.
  useEffect(() => {
    setItems([]); setError(undefined); setErrorCode(undefined);
    if (!clusterId) { setLoading(false); return; }
    let active = true;
    const id = crypto.randomUUID(); setLoading(true);
    const unsubscribe = window.desktop.subscribe(event => {
      if (!active || event.id !== id) return;
      if (event.type === 'resources') { setItems(event.items); setLoading(false); setError(undefined); setErrorCode(undefined); }
      if (event.type === 'error') { setError(event.error.message); setErrorCode(event.error.code); setLoading(false); }
    });
    void request('resources:watch', { id, clusterId, kind, namespace: namespace || undefined, custom, ...(fieldSelector ? { fieldSelector } : {}) }).catch(e => { if (active) { setError(e.message); setErrorCode((e as { code?: string }).code); setLoading(false); } });
    return () => { active = false; unsubscribe(); closeStream(id); };
  }, [clusterId, kind, namespace, revision, custom?.apiVersion, custom?.plural, fieldSelector]);
  return { items, loading, error, errorCode, refresh: () => setRevision(v => v + 1) };
}
