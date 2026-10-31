import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { z } from 'zod';
import { findTool } from './external-tools';
import { AppError } from './errors';
import { awsLoginSchema, type AwsLogin, eksImportSchema, eksScopeSchema, type EksScope } from '../shared/eks';
const execute = promisify(execFile);
export function eksError(error: any): AppError {
  const message = String(error?.stderr || '');
  if (/AccessDenied|UnauthorizedOperation/.test(message)) return new AppError('AWS_DENIED', 'AWS denied access. Check the selected profile permissions for the requested operation (EKS discovery requires eks:ListClusters and eks:DescribeCluster).');
  if (/SSO|ExpiredToken|InvalidClientTokenId|Unable to locate credentials|credential/i.test(message)) return new AppError('AWS_AUTH', 'AWS credentials are missing or expired. Sign in with the AWS CLI for this profile, then retry.');
  if (/ResourceNotFound/.test(message)) return new AppError('AWS_NOT_FOUND', 'This EKS cluster no longer exists in the selected region. Refresh the list.');
  return new AppError('AWS_FAILED', 'AWS request failed or timed out. Check the profile, region, network and AWS CLI configuration.');
}
export class EksDiscovery {
  constructor(private run = async (file: string, args: string[]) => {
    try { return (await execute(file, args, { windowsHide: true, timeout: 45000, maxBuffer: 2_000_000, env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' } })).stdout; }
    catch (error) { throw eksError(error); }
  }, private locate = () => findTool('aws')) {}
  private file() { const path = this.locate(); if (!path || /\.(cmd|bat)$/i.test(path)) throw new AppError('AWS_MISSING', 'Install AWS CLI v2 and restart Optic so aws is available on PATH.'); return path; }
  private flags(scope: EksScope) { return ['--region', scope.region, ...(scope.profile ? ['--profile', scope.profile] : []), '--output', 'json', '--cli-connect-timeout', '10', '--cli-read-timeout', '30']; }
  async profiles() {
    const file = this.file();
    const text = await this.run(file, ['configure', 'list-profiles']);
    return [...new Set(text.split(/\r?\n/).map(v => v.trim()).filter(v => v && /^[\w.@+-]{1,256}$/.test(v)))].sort();
  }
  async identity(input: EksScope) {
    const scope = eksScopeSchema.parse(input);
    const result = z.object({ Account: z.string().regex(/^\d{12}$/), Arn: z.string().startsWith('arn:') }).parse(JSON.parse(await this.run(this.file(), ['sts', 'get-caller-identity', ...this.flags(scope)])));
    return { account: result.Account, arn: result.Arn };
  }
  async defaultRegion(profile: string) {
    eksScopeSchema.shape.profile.parse(profile);
    try { const value = (await this.run(this.file(), ['configure', 'get', 'region', ...(profile ? ['--profile', profile] : [])])).trim(); return eksScopeSchema.shape.region.safeParse(value).success ? value : undefined; }
    catch { return undefined; }
  }
  async list(input: EksScope & { nextToken?: string }) {
    const scope = eksScopeSchema.parse({ profile: input.profile, region: input.region });
    const args = ['eks', 'list-clusters', ...this.flags(scope), '--max-items', '100', ...(input.nextToken ? ['--starting-token', input.nextToken] : [])];
    const data = z.object({ clusters: z.array(z.string().max(100)).max(100), NextToken: z.string().max(8192).optional() }).parse(JSON.parse(await this.run(this.file(), args)));
    return { names: data.clusters, nextToken: data.NextToken };
  }
  async kubeconfig(input: EksScope & { name: string; roleArn?: string }) {
    const scope = eksImportSchema.parse(input), file = this.file();
    const result = JSON.parse(await this.run(file, ['eks', 'describe-cluster', '--name', scope.name, ...this.flags(scope)]));
    const cluster = z.object({ name: z.string(), arn: z.string().regex(/^arn:aws[a-z-]*:eks:/), endpoint: z.string().url(), certificateAuthority: z.object({ data: z.string().min(1) }), status: z.string(), id: z.string().optional() }).parse(result.cluster);
    if (cluster.name !== scope.name || !cluster.endpoint.startsWith('https://') || !['ACTIVE', 'UPDATING'].includes(cluster.status)) throw new AppError('EKS_NOT_READY', 'The selected cluster does not have a ready API endpoint yet.');
    const context = `${cluster.arn}${scope.profile ? `@${scope.profile}` : ''}${scope.roleArn ? `#${scope.roleArn}` : ''}`;
    return stringify({ apiVersion: 'v1', kind: 'Config', 'current-context': context,
      clusters: [{ name: context, cluster: { server: cluster.endpoint, 'certificate-authority-data': cluster.certificateAuthority.data } }],
      contexts: [{ name: context, context: { cluster: context, user: context } }],
      users: [{ name: context, user: { exec: { apiVersion: 'client.authentication.k8s.io/v1beta1', command: file, args: ['eks', 'get-token', cluster.id ? '--cluster-id' : '--cluster-name', cluster.id || scope.name, ...this.flags(scope), ...(scope.roleArn ? ['--role-arn', scope.roleArn] : [])], interactiveMode: 'Never' } } }],
    });
  }
}

export function awsLoginCommand(input: AwsLogin, locate = () => findTool('aws')) {
  const options = awsLoginSchema.parse(input), file = locate();
  if (!file || /\.(cmd|bat)$/i.test(file)) throw new AppError('AWS_MISSING', 'Install AWS CLI v2 and restart Optic.');
  return { file, args: [...(options.action === 'configure' ? ['configure', 'sso'] : ['sso', 'login']), ...(options.profile ? ['--profile', options.profile] : [])] };
}
