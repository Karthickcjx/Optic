import { expect, it } from 'vitest';
import { fault } from '../src/main/errors';

it('classifies nested fetch transport failures without exposing request details', () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
    const error = new TypeError('fetch failed: secret-token', { cause: Object.assign(new Error('private-host'), { code }) });
    expect(fault(error)).toMatchObject({ code: 'UNREACHABLE', retryable: true });
    expect(JSON.stringify(fault(error))).not.toMatch(/secret-token|private-host/);
  }
});
it('classifies nested timeouts and preserves HTTP status precedence', () => {
  expect(fault(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).code).toBe('TIMEOUT');
  expect(fault({ cause: { name: 'TimeoutError' } }).code).toBe('TIMEOUT');
  expect(fault({ statusCode: 403, cause: { code: 'ENOTFOUND' } }).code).toBe('FORBIDDEN');
});
it('handles circular and non-error causes', () => {
  const error: { cause?: unknown } = {}; error.cause = error;
  expect(fault(error).code).toBe('REQUEST_FAILED');
  expect(fault(undefined).code).toBe('REQUEST_FAILED');
  expect(fault({ cause: 'private text' }).code).toBe('REQUEST_FAILED');
});
