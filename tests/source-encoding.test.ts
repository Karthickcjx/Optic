import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(tsx?|css|html)$/.test(e.name) ? [join(dir, e.name)] : []);
const sources = files('src');

describe('source encoding', () => {
  it('stores every source file as valid UTF-8 without replacement characters', () => {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const invalid = sources.filter(file => { try { return decoder.decode(readFileSync(file)).includes('�'); } catch { return true; } });
    expect(invalid).toEqual([]);
  });
  it('has no separator characters lost to "?" in UI strings', () => {
    // " ? " between words inside a quoted string, or between two template expressions, is a lost separator (·, –, →), never a ternary.
    const lost = /'[A-Za-z][^'\n]{0,80} \? [A-Za-z][^'\n]{0,80}'|\} \? \$\{/;
    expect(sources.filter(file => lost.test(readFileSync(file, 'utf8')))).toEqual([]);
  });
});
