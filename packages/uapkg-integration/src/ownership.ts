import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pluginName, unrealName } from '#integration/definition.ts';

const descriptorRef = z.looseObject({ Name: z.string().min(1), Enabled: z.boolean().optional() });
export const descriptor = z.looseObject({
  Plugins: z.array(descriptorRef).optional(),
  Modules: z.array(z.looseObject({ Name: unrealName })).optional(),
});
export type Descriptor = z.infer<typeof descriptor>;
export type PluginRef = z.infer<typeof descriptorRef>;
const pluginOwner = z.strictObject({
  file: z.string(),
  name: pluginName,
  owners: z.array(z.string()).nonempty(),
  prior: descriptorRef.nullable(),
  fingerprint: z.string(),
  createdList: z.boolean(),
});
export const zones = ['includes', 'classBody', 'constructorBody'] as const;
const blockOwner = z.strictObject({
  file: z.string(),
  zone: z.enum(zones),
  contributions: z.array(z.strictObject({ owner: z.string(), snippets: z.array(z.string()).nonempty() })).nonempty(),
  expected: z.string(),
  fingerprint: z.string(),
  prefix: z.string(),
  suffix: z.string(),
});
export type PluginOwner = z.infer<typeof pluginOwner>;
export type BlockOwner = z.infer<typeof blockOwner>;
export type Zone = (typeof zones)[number];
export const ownership = z.strictObject({
  version: z.literal(1),
  plugins: z.array(pluginOwner),
  blocks: z.array(blockOwner),
});
export type Ownership = z.infer<typeof ownership>;
export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
export function lineEnding(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
export function conflict(file: string, current: string | null, expected: string | null): never {
  const lines = (value: string | null, prefix: string) =>
    (value ?? '(absent)')
      .split(/\r?\n/)
      .map((line) => prefix + line)
      .join('\n');
  throw new Error(
    `Integration conflict in ${file}. Your edit was preserved. Apply the expected change manually and rerun.\n--- current\n+++ expected\n${lines(current, '-')}\n${lines(expected, '+')}`,
  );
}
export function readDescriptor(text: string): Descriptor {
  return descriptor.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
}
