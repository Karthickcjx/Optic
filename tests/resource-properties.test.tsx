import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResourceProperties, ContainerProperties } from '../src/renderer/src/ResourceProperties';
it('shows pod health, ownership and scheduling details', () => {
 const html = renderToStaticMarkup(<ResourceProperties resource={{ kind: 'Pod', metadata: { name: 'p', ownerReferences: [{ kind: 'ReplicaSet', name: 'owner' }] }, spec: { nodeName: 'worker', serviceAccountName: 'app', tolerations: [{ operator: 'Exists' }] }, status: { podIP: '10.1.1.2', qosClass: 'Burstable', conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady' }] } }}/>);
 for (const value of ['worker', '10.1.1.2', 'Burstable', 'ContainersNotReady', 'ReplicaSet', 'Tolerations']) expect(html).toContain(value);
});
it('shows container termination and probes without resolving secret references or exposing sensitive literals', () => {
 const html = renderToStaticMarkup(<ContainerProperties category="Init" container={{ env: [{ name: 'API_TOKEN', value: 'private-token' }, { name: 'CONFIG', valueFrom: { secretKeyRef: { name: 'config', key: 'value' } } }], readinessProbe: { tcpSocket: { port: 8080 } } }} status={{ restartCount: 3, state: { terminated: { exitCode: 1, reason: 'Error' } } }}/>);
 expect(html).toContain('exitCode'); expect(html).toContain('8080'); expect(html).toContain('secretKeyRef'); expect(html).not.toContain('private-token');
});
it('shows workload rollout counts and never renders Secret data', () => {
 const html = renderToStaticMarkup(<ResourceProperties resource={{ kind: 'Deployment', metadata: {}, spec: { replicas: 3, strategy: { type: 'RollingUpdate' } }, status: { readyReplicas: 2 } }}/>);
 expect(html).toContain('Ready replicas'); expect(html).toContain('RollingUpdate');
 const secret = renderToStaticMarkup(<ResourceProperties resource={{ kind: 'Secret', metadata: {}, data: { password: 'private-value' } }}/>);
 expect(secret).not.toContain('private-value'); expect(secret).toContain('redacted');
});
