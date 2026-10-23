import { it, expect } from 'vitest';
import { selectNodes, scopedUsage } from '../src/shared/metrics';
import type { Resource } from '../src/shared/protocol';
const nodes: Resource[] = [
 { metadata: { name: 'master', labels: { 'node-role.kubernetes.io/control-plane': '' } }, status: { addresses: [{ address: '10.0.0.1' }] } },
 { metadata: { name: 'worker' }, status: { addresses: [{ address: '10.0.0.2' }] } },
 { metadata: { name: 'legacy', labels: { 'node-role.kubernetes.io/master': '' } } }
];
it('selects control-plane nodes using label presence, workers, and individual nodes', () => {
 expect(selectNodes(nodes, 'masters').map(n => n.metadata.name)).toEqual(['master', 'legacy']);
 expect(selectNodes(nodes, 'workers').map(n => n.metadata.name)).toEqual(['worker']);
 expect(selectNodes(nodes, 'node:master').length).toBe(1);
});
it('maps instance addresses to selected nodes without including cluster aggregates', () => {
 const samples = [{ metadata: { name: '10.0.0.2:10250' }, usage: { cpu: '250m', memory: '1Gi' } }, { metadata: { name: 'master' }, usage: { cpu: '1' } }, { metadata: { name: 'cluster' }, usage: { cpu: '10' } }];
 expect(scopedUsage(samples, selectNodes(nodes, 'workers'), false)).toEqual({ cpu: 0.25, memory: 1073741824, available: true });
 expect(scopedUsage(samples, selectNodes(nodes, 'node:legacy'), false).available).toBe(false);
});
