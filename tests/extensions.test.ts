import { it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { Extensions, readExtension, readExtensionArchive } from '../src/main/extensions';
import { extensionManifestSchema, extensionPanelSchema } from '../src/shared/extensions';
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), session: {} }));
const roots: string[] = [];
const manifest = { apiVersion: 1, id: 'test.example', name: 'Example', version: '1.0.0', description: 'Test', permissions: [], commands: [{ id: 'hello', title: 'Hello' }] };
function setup() { const root = mkdtempSync(join(tmpdir(), 'optic-extension-test-')); roots.push(root); const source = join(root, 'source'); mkdirSync(source); writeFileSync(join(source, 'optic-extension.json'), JSON.stringify(manifest)); writeFileSync(join(source, 'extension.js'), "optic.registerCommand('hello', () => ({title:'Hello'}));"); return { root, source, manager: new Extensions(join(root, 'installed')) }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('validates identity, API, permissions, commands and bounded output', () => {
 expect(extensionManifestSchema.safeParse(manifest).success).toBe(true);
 for (const patch of [{id:'../escape'}, {apiVersion:2}, {permissions:['shell']}, {commands:[manifest.commands[0],manifest.commands[0]]}, {main:'../../code.js'}]) expect(extensionManifestSchema.safeParse({...manifest,...patch}).success).toBe(false);
 expect(extensionPanelSchema.safeParse({title:'text',html:'<script>'}).success).toBe(false);
 expect(extensionPanelSchema.safeParse({title:'text',text:'a'.repeat(20001)}).success).toBe(false);
});
it('installs only the reviewed snapshot and scopes review tokens to their window', async () => {
 const {manager,source,root}=setup(); const review=await manager.review(source,1);
 expect(()=>manager.install(review.token,2)).toThrow('review');
 writeFileSync(join(source,'extension.js'),'modified after review');
 manager.install(review.token,1);
 expect(manager.list()[0]).toMatchObject({enabled:false,status:'disabled'});
 expect(readFileSync(join(root,'installed',`${manifest.id}.json`),'utf8')).not.toContain('modified after review');
 expect(()=>manager.install(review.token,1)).toThrow('review');
 manager.remove(manifest.id); expect(manager.list()).toEqual([]);
});
it('rejects tampered installed code and retains Safe Mode across restart', async () => {
 const {manager,source,root}=setup(); manager.install((await manager.review(source,1)).token,1);
 await manager.setSafeMode(true);
 const restored=new Extensions(join(root,'installed')); expect(restored.safeMode()).toBe(true);
 await expect(restored.enable(manifest.id,true)).rejects.toThrow('Safe Mode');
 const file=join(root,'installed',`${manifest.id}.json`);const bundle=JSON.parse(readFileSync(file,'utf8'));bundle.code+='tampered';writeFileSync(file,JSON.stringify(bundle));
 expect(new Extensions(join(root,'installed')).list()).toEqual([]);
});
it('imports a bounded tgz snapshot without extracting filesystem paths', async () => {
 const {source,root}=setup(),archive=join(root,'extension.tgz');
 await create({gzip:true,cwd:source,file:archive},['optic-extension.json','extension.js']);
 expect((await readExtensionArchive(archive)).digest).toBe(readExtension(source).digest);
 writeFileSync(join(source,'extension.js'),'a'.repeat(1_000_001));
 expect(()=>readExtension(source)).toThrow('Invalid bundle');
 await create({gzip:true,cwd:source,file:archive},['optic-extension.json','extension.js']);
 await expect(readExtensionArchive(archive)).rejects.toThrow();
});
