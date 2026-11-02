// Names whose values are treated as credentials (same rule the resource panels use for environment values).
export const sensitiveName = /password|passwd|secret|token|credential|api.?key|private.?key|access.?key/i;

// Credentials embedded in free text: authorization headers, JWTs, PEM private keys and key=value arguments.
const textPatterns: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted token]'],
  [/\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)[\w.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi, '$1$2[redacted]']
];
export function redactText(value: string) { return textPatterns.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value); }

// Returns a copy safe to show to an AI client: Secret payloads removed, sensitive fields and annotations masked,
// last-applied configuration (which can embed whole Secrets) dropped, and credential-looking text redacted.
export function redactResource<T>(value: T): T {
  const walk = (node: unknown, key = ''): unknown => {
    // References such as secretName or tokenSecretRef name an object; they are not credentials.
    if (typeof node === 'string') return sensitiveName.test(key) && !/(?:Name|Ref)$/.test(key) ? '[redacted]' : redactText(node);
    if (Array.isArray(node)) return node.map(item => walk(item));
    if (!node || typeof node !== 'object') return node;
    const object = node as Record<string, unknown>, out: Record<string, unknown> = {};
    // Environment entries and similar name/value pairs: the name decides whether the value is sensitive.
    const pairSensitive = typeof object.name === 'string' && 'value' in object && sensitiveName.test(object.name);
    for (const [k, v] of Object.entries(object)) {
      if (k === 'managedFields' || k === 'kubectl.kubernetes.io/last-applied-configuration') continue;
      out[k] = k === 'value' && pairSensitive && typeof v === 'string' ? '[redacted]' : walk(v, k);
    }
    return out;
  };
  const copy = walk(value) as Record<string, any>;
  if (copy && copy.kind === 'Secret' && (copy.apiVersion === 'v1' || copy.apiVersion === undefined)) {
    const keys = [...new Set([...Object.keys(copy.data ?? {}), ...Object.keys(copy.stringData ?? {})])];
    delete copy.data; delete copy.stringData; if (copy.metadata) delete copy.metadata.annotations;
    copy.dataKeys = keys;
  }
  return copy as T;
}
