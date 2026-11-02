import type { KubeConfig } from '@kubernetes/client-node';
import type { CustomType } from '../shared/catalog';
import { gitopsTypes, type GitOpsDetection, type GitOpsType } from '../shared/gitops';
import { kubeJson } from './kube-http';

type Group = { name: string; versions?: { groupVersion: string }[]; preferredVersion?: { groupVersion: string } };
type ResourceList = { resources?: { name: string; kind: string; namespaced: boolean; verbs?: string[] }[] };

// Finds installed Argo CD / Flux types through API discovery, which every authenticated user may read, so detection
// does not depend on CRD-list permissions. A type counts only if it can be listed and watched (the views use a watch).
export async function detectGitOps(config: KubeConfig): Promise<GitOpsDetection> {
  const groups = (await kubeJson<{ groups?: Group[] }>(config, '/apis')).groups ?? [];
  const wanted = new Set<string>(Object.values(gitopsTypes).map(t => t.group));
  const types: GitOpsDetection['types'] = {}, unavailableGroups: string[] = [];
  await Promise.all(groups.filter(g => wanted.has(g.name)).map(async group => {
    const versions = [...new Set([group.preferredVersion?.groupVersion, ...(group.versions ?? []).map(v => v.groupVersion)].filter((v): v is string => !!v))];
    const pending = (Object.keys(gitopsTypes) as GitOpsType[]).filter(type => gitopsTypes[type].group === group.name);
    try {
      for (const groupVersion of versions) {
        const resources = (await kubeJson<ResourceList>(config, `/apis/${groupVersion}`)).resources ?? [];
        for (const type of pending.filter(t => !types[t])) {
          const r = resources.find(r => r.name === type && r.kind === gitopsTypes[type].kind);
          if (r && ['list', 'watch'].every(v => r.verbs?.includes(v))) types[type] = { apiVersion: groupVersion, kind: r.kind, plural: r.name, namespaced: r.namespaced } satisfies CustomType;
        }
        if (pending.every(t => types[t])) break;
      }
    } catch { unavailableGroups.push(group.name); }
  }));
  return { types, unavailableGroups: unavailableGroups.sort() };
}

// Argo CD publishes its external address in the argocd-cm ConfigMap (data.url). Only http(s) URLs without embedded
// credentials are accepted; without one (or without permission to read the ConfigMap) Optic offers no link.
export function safeArgoUrl(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try { const url = new URL(value.trim()); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash ? `${url.origin}${url.pathname.replace(/\/+$/, '')}` : undefined; } catch { return undefined; }
}
export async function argoUrl(config: KubeConfig, namespace: string) {
  try { return safeArgoUrl((await kubeJson<{ data?: Record<string, string> }>(config, `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/argocd-cm`)).data?.url); } catch { return undefined; }
}
export const argoApplicationUrl = (base: string, application?: { namespace: string; name: string }) => application ? `${base}/applications/${encodeURIComponent(application.namespace)}/${encodeURIComponent(application.name)}` : `${base}/applications`;
