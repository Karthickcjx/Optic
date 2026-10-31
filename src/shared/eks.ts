import { z } from 'zod';
export const eksScopeSchema = z.object({ profile: z.string().max(256).regex(/^[\w.@+-]*$/), region: z.string().max(64).regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/) }).strict();
export const eksImportSchema = eksScopeSchema.extend({ roleArn: z.string().max(2048).regex(/^arn:aws[a-z-]*:iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_\/-]+$/).optional(), name: z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/) });
export type EksScope = z.infer<typeof eksScopeSchema>;
export interface EksPage { names: string[]; nextToken?: string }

export interface EksIdentity { account: string; arn: string }

export const awsLoginSchema = z.object({ action: z.enum(['login', 'configure']), profile: eksScopeSchema.shape.profile }).strict();
export type AwsLogin = z.infer<typeof awsLoginSchema>;
