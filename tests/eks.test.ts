import { it, expect, vi } from 'vitest';
import { parse } from 'yaml';
import { EksDiscovery, eksError } from '../src/main/eks';
import { eksScopeSchema, eksImportSchema } from '../src/shared/eks';
vi.mock('electron', () => ({ app: {} }));
it('validates region, profile and cluster boundaries', () => {
 expect(eksScopeSchema.safeParse({profile:'dev-admin',region:'us-gov-west-1'}).success).toBe(true);
 expect(eksImportSchema.safeParse({profile:'dev',region:'us-east-1',name:'test'}).success).toBe(true);
 for(const region of ['--endpoint-url','https://localhost','us-east-1;echo']) expect(eksScopeSchema.safeParse({profile:'dev',region}).success).toBe(false);
 expect(eksImportSchema.safeParse({profile:'dev',region:'us-east-1',name:'--debug'}).success).toBe(false);
});
it('uses bounded CLI pages and passes opaque continuation tokens as argv', async () => {
 const run=vi.fn(async(_file: string, _args: string[])=>JSON.stringify({clusters:['demo'],NextToken:'opaque='}));
 const service=new EksDiscovery(run,()=>'/bin/aws');
 expect(await service.list({profile:'dev',region:'us-east-1',nextToken:'old='})).toEqual({names:['demo'],nextToken:'opaque='});
 expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['--profile','dev','--region','us-east-1','--max-items','100','--starting-token','old=']));
});
it('generates a dedicated config retaining profile and avoiding stored tokens',async()=>{
 const run=vi.fn(async(_file: string, _args: string[])=>JSON.stringify({cluster:{name:'demo',arn:'arn:aws:eks:us-east-1:123456789012:cluster/demo',endpoint:'https://example.eks.amazonaws.com',certificateAuthority:{data:'Y2E='},status:'ACTIVE'}}));
 const result=parse(await new EksDiscovery(run,()=>'/bin/aws').kubeconfig({profile:'dev',region:'us-east-1',name:'demo'}));
 expect(result.users[0].user.exec.command).toBe('/bin/aws');
 expect(result.users[0].user.exec.args).toEqual(expect.arrayContaining(['get-token','--profile','dev','--cluster-name','demo']));
 expect(result.users[0].user.token).toBeUndefined();
 expect(result.clusters).toHaveLength(1);
 expect(result.clusters[0].cluster['insecure-skip-tls-verify']).toBeUndefined();
 expect(result.contexts[0].name).toContain('@dev');
});
it('reports missing CLI and redacts raw AWS errors',async()=>{
 await expect(new EksDiscovery(undefined,()=>undefined).profiles()).rejects.toThrow('Install AWS CLI');
 expect(eksError({stderr:'AccessDenied secret text'}).message).not.toContain('secret');
 expect(eksError({stderr:'ExpiredToken secret text'}).code).toBe('AWS_AUTH');
});
it('verifies the caller identity and loads configured region',async()=>{
 const run=vi.fn(async(_file:string,args:string[])=>args[0]==='sts'?JSON.stringify({Account:'123456789012',Arn:'arn:aws:iam::123456789012:user/test'}):'ap-south-1\n');
 const service=new EksDiscovery(run,()=>'/bin/aws');
 expect(await service.identity({profile:'dev',region:'us-east-1'})).toEqual({account:'123456789012',arn:'arn:aws:iam::123456789012:user/test'});
 expect(await service.defaultRegion('dev')).toBe('ap-south-1');
});
it('retains authentication role only in token invocation and separates contexts',async()=>{
 const run=vi.fn(async(_file:string,_args:string[])=>JSON.stringify({cluster:{name:'demo',arn:'arn:aws:eks:us-east-1:123456789012:cluster/demo',endpoint:'https://example.eks.amazonaws.com',certificateAuthority:{data:'Y2E='},status:'ACTIVE'}}));
 const roleArn='arn:aws:iam::123456789012:role/EksAccess';
 const result=parse(await new EksDiscovery(run,()=>'/bin/aws').kubeconfig({profile:'dev',region:'us-east-1',name:'demo',roleArn}));
 expect(run.mock.calls[0][1]).not.toContain('--role-arn');
 expect(result.users[0].user.exec.args).toEqual(expect.arrayContaining(['--role-arn',roleArn]));
 expect(result.contexts[0].name).toContain(roleArn);
 expect(eksImportSchema.safeParse({profile:'dev',region:'us-east-1',name:'demo',roleArn:'--debug'}).success).toBe(false);
});
it('creates fixed SSO commands and rejects option injection',async()=>{
 const {awsLoginCommand}=await import('../src/main/eks');
 expect(awsLoginCommand({action:'login',profile:'engineering'},()=>'/bin/aws')).toEqual({file:'/bin/aws',args:['sso','login','--profile','engineering']});
 expect(awsLoginCommand({action:'configure',profile:''},()=>'/bin/aws').args).toEqual(['configure','sso']);
 expect(()=>awsLoginCommand({action:'login',profile:'dev;echo bad'},()=>'/bin/aws')).toThrow();
});
