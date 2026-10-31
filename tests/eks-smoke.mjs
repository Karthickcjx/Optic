import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root=await mkdtemp(join(tmpdir(),'optic-eks-ui-'));
const env={...process.env,WORKBENCH_KUBECONFIG:join(root,'absent')};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL;
let app;
try {
 app=await electron.launch({args:['.',`--user-data-dir=${root}`],env});
 const page=await app.firstWindow();
 // Exercise renderer flow without using or modifying a real AWS account.
 await app.evaluate(({ipcMain})=>{
  for(const channel of ['eks:profiles','eks:list','eks:import','eks:identity','eks:region']) ipcMain.removeHandler(channel);
  ipcMain.handle('eks:region',()=>({ok:true,data:'us-east-1'}));
  ipcMain.handle('eks:identity',()=>({ok:true,data:{account:'123456789012',arn:'arn:aws:iam::123456789012:user/test'}}));
  ipcMain.handle('eks:profiles',()=>({ok:true,data:['default','engineering','production']}));
  ipcMain.handle('eks:list',(_event,input)=>input.region==='us-west-2'?{ok:false,error:{code:'AWS_AUTH',message:'AWS credentials are missing or expired.',retryable:false}}:{ok:true,data:input.nextToken?{names:['cluster-b']}:{names:['cluster-a'],nextToken:'next'}});
  ipcMain.handle('eks:import',()=>({ok:true,data:{clusters:[],warnings:[]}}));
 });
 await page.getByTitle('Add cluster',{exact:true}).click();
 await page.getByRole('button',{name:'Discover AWS EKS clusters'}).click();
 const dialog=page.getByRole('dialog',{name:'Discover AWS EKS clusters'});
 await expect(dialog.getByRole('combobox')).toContainText('engineering');
 await dialog.getByRole('combobox').selectOption('engineering');
 await dialog.getByRole('button',{name:'Verify AWS identity'}).click();
 await expect(dialog).toContainText('Account 123456789012');
 await dialog.getByRole('button',{name:'Discover clusters',exact:true}).click();
 await expect(dialog).toContainText('cluster-a');
 await dialog.getByRole('button',{name:'Load more clusters'}).click();
 await expect(dialog).toContainText('cluster-b');
 await dialog.getByRole('button',{name:'Add cluster',exact:true}).first().click();
 await expect(dialog.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
 await mkdir('artifacts/eks',{recursive:true});await page.screenshot({path:'artifacts/eks/discovery.png'});
 await dialog.getByLabel('AWS region').fill('us-west-2');
 await expect(dialog).not.toContainText('cluster-a');
 await dialog.getByRole('button',{name:'Discover clusters',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('credentials');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
 await page.getByRole('button',{name:'AWS EKS',exact:true}).click();
 await expect(page.locator('.aws-profile-navigation')).toContainText('engineering');
 await expect(page.getByTitle('Discover EKS clusters with default')).toHaveCount(0);
 await page.getByRole('button',{name:'Manage AWS connections',exact:true}).click();
 await expect(dialog).toBeVisible();
 await expect(dialog.getByRole('combobox')).toHaveValue('');
 await page.keyboard.press('Escape');
 await page.getByTitle('Discover EKS clusters with engineering').click();
 await expect(dialog.getByRole('combobox')).toHaveValue('engineering');
 // Capture the typed terminal request without triggering browser authentication.
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('terminal:open');globalThis.awsLoginRequests=[];ipcMain.handle('terminal:open',(_e,input)=>{globalThis.awsLoginRequests.push(input);return {ok:true};});});
 await dialog.getByRole('button',{name:'Sign in with SSO',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 await expect.poll(()=>app.evaluate(()=>globalThis.awsLoginRequests.length)).toBe(1);
 const login=await app.evaluate(()=>globalThis.awsLoginRequests[0]);
 if(login.awsLogin.profile!=='engineering'||login.awsLogin.action!=='login'||login.clusterId)throw Error('Incorrect SSO terminal scope');
 await page.getByTitle('Discover EKS clusters with engineering').click();
 await dialog.getByRole('button',{name:'Configure SSO profile',exact:true}).click();
 await expect.poll(()=>app.evaluate(()=>globalThis.awsLoginRequests.length)).toBe(2);
 const setup=await app.evaluate(()=>globalThis.awsLoginRequests[1]);
 if(setup.awsLogin.action!=='configure')throw Error('Incorrect SSO setup action');
 await page.reload();
 await expect(page.getByRole('button',{name:'AWS EKS',exact:true})).toHaveAttribute('aria-expanded','true');
 await expect(page.locator('.aws-profile-navigation')).toContainText('engineering');

 console.log('PASS: EKS discovery UI with fixture responses: profiles, pagination, import acknowledgement, scope reset, authentication errors and close.');
} finally {await app?.close();await rm(root,{recursive:true,force:true});}
