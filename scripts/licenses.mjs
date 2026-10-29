import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Use the lockfile's production closure, including transitive dependencies.
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const sections = ['Optic third-party notices\nGenerated from package-lock.json. Electron/Chromium notices are also included alongside the application executable.'];
for (const [path, entry] of Object.entries(lock.packages).sort()) {
  if (!path || entry.dev || entry.devOptional) continue;
  let files;
  try { files = await readdir(path); } catch { if (entry.optional) continue; throw new Error(`Missing production dependency: ${path}`); }
  const names = files.filter(name => /^(licen[sc]e|unlicense|copying|notice)(\.|$)/i.test(name));
  const texts = [];
  for (const name of names) {
    try { texts.push(await readFile(join(path, name), 'utf8')); } catch (error) { if (error.code !== 'EISDIR') throw error; }
  }
  if (!texts.length) throw new Error(`Missing license text for ${path}; review before distribution.`);
  sections.push(`${path.replace(/^node_modules\//, '')}@${entry.version}\nLicense: ${entry.license ?? 'See license text'}\n\n${texts.join('\n\n')}`);
}
await writeFile('resources/THIRD_PARTY_NOTICES.txt', sections.join('\n\n' + '='.repeat(80) + '\n\n'));
console.log(`Generated notices for ${sections.length - 1} production dependencies.`);
