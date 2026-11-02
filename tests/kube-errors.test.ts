import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { fault, AppError } from '../src/main/errors';
import { kubeFailure, kubeJson } from '../src/main/kube-http';
import { SessionService } from '../src/main/sessions';
import { Streams } from '../src/main/streams';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const status = (code: number, message: string, extra: object = {}) => ({ kind: 'Status', apiVersion: 'v1', status: 'Failure', message, code, ...extra });
const json = (body: unknown, code: number, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: code, headers: { 'content-type': type } });
const waiting = 'container "app" in pod "web" is waiting to start: ContainerCreating';
const forbidden = 'pods "web" is forbidden: User "dev" cannot get resource "pods/log" in API group "" in the namespace "team"';

describe('kubeFailure', () => {
  it('keeps Kubernetes Status messages with the HTTP status', async () => {
    const error = await kubeFailure(json(status(400, waiting), 400), 'Log request failed');
    expect(error).toMatchObject({ message: 'Log request failed', statusCode: 400, kubernetesMessage: waiting });
  });
  it('ignores bodies that are not a v1 Status', async () => {
    for (const response of [
      json({ message: 'proxied service body' }, 500),
      json({ kind: 'Status', message: 'no apiVersion' }, 500),
      json(status(500, '   '), 500),
      json('{"kind":"Status",', 500),
      json(status(403, forbidden), 403, 'text/plain'),
      json({ ...status(500, 'too large'), padding: 'x'.repeat(70000) }, 500)
    ]) {
      const error = await kubeFailure(response, 'Kubernetes request failed');
      expect(error).not.toHaveProperty('kubernetesMessage');
      expect(error.statusCode).toBe(response.status);
    }
  });
});

describe('fault with Kubernetes Status messages', () => {
  const failure = (statusCode: number, kubernetesMessage?: string) => Object.assign(new Error('Kubernetes request failed'), { statusCode, ...(kubernetesMessage ? { kubernetesMessage } : {}) });
  it('explains failures with the API server message while keeping codes and retry hints', () => {
    expect(fault(failure(400, waiting))).toEqual({ code: 'INVALID_RESOURCE', message: `Kubernetes API: ${waiting}`, retryable: false });
    expect(fault(failure(403, forbidden))).toEqual({ code: 'FORBIDDEN', message: `Kubernetes API: ${forbidden}`, retryable: false });
    const conflict = 'Apply failed with 1 conflict: conflict with "kubectl" using apps/v1: .spec.replicas';
    expect(fault(failure(409, conflict))).toEqual({ code: 'CONFLICT', message: `Kubernetes API: ${conflict}`, retryable: true });
    const webhook = 'Internal error occurred: failed calling webhook "validate.example.com": context deadline exceeded';
    expect(fault(failure(500, webhook))).toEqual({ code: 'REQUEST_FAILED', message: `Kubernetes API: ${webhook}`, retryable: true });
  });
  it('keeps the existing generic messages when no Status message exists', () => {
    expect(fault(failure(400)).message).toBe('Kubernetes rejected the resource. Check its required fields, API version and schema.');
    expect(fault(failure(403)).message).toBe('The cluster rejected this request. Check credentials and RBAC permissions.');
    expect(fault(failure(404)).message).toBe('This resource or API is unavailable.');
    expect(fault(failure(500)).message).toBe('Request failed. Check cluster connectivity, kubeconfig authentication, and installed command-line tools.');
  });
  it('sanitizes and bounds forwarded messages', () => {
    const result = fault(failure(401, `denied\n\tAuthorization: Bearer abc.def-ghi and basic dXNlcjpwYXNz ${'x'.repeat(2000)}`));
    expect(result.message).not.toMatch(/abc\.def-ghi|dXNlcjpwYXNz|[\n\t]/);
    expect(result.message).toContain('Bearer [redacted]');
    expect(result.message.length).toBeLessThanOrEqual('Kubernetes API: '.length + 1000);
  });
  it('never forwards transport or application error text', () => {
    expect(JSON.stringify(fault(new TypeError('fetch failed: secret-token', { cause: { code: 'ECONNREFUSED' } })))).not.toContain('secret-token');
    expect(fault(Object.assign(new AppError('BUSY', 'Wait.'), { kubernetesMessage: 'ignored' })).message).toBe('Wait.');
  });
});

describe('Kubernetes API failures end to end', () => {
  let server: Server, config: KubeConfig;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const body = req.url?.includes('/log') ? status(400, waiting) : status(403, forbidden);
      res.writeHead(body.code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config = new KubeConfig();
    config.loadFromOptions({ clusters: [{ name: 'test', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }], users: [{ name: 'user' }], contexts: [{ name: 'test', cluster: 'test', user: 'user' }], currentContext: 'test' });
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
  it('surfaces RBAC denials from kubeJson', async () => {
    const error = await kubeJson(config, '/api/v1/namespaces/team/pods/web').catch(e => e);
    expect(fault(error)).toEqual({ code: 'FORBIDDEN', message: `Kubernetes API: ${forbidden}`, retryable: false });
  });
  it('surfaces why a pod log stream cannot start', async () => {
    const streams = new Streams(), owner = { id: 1, isDestroyed: () => false, send: vi.fn() } as any;
    const service = new SessionService({ get: () => ({ config }) } as any, streams);
    const error = await service.logs(owner, { id: crypto.randomUUID(), clusterId: 'c', namespace: 'team', pod: 'web', container: 'app' }).catch(e => e);
    expect(fault(error)).toEqual({ code: 'INVALID_RESOURCE', message: `Kubernetes API: ${waiting}`, retryable: false });
  });
});
