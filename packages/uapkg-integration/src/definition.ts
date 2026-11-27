import { z } from 'zod';

export const unrealName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Expected an Unreal identifier');
export const pluginName = z
  .string()
  .min(1)
  .regex(/^[^/\\:*?"<>|]+$/u, 'Expected an Unreal plugin descriptor stem')
  .refine((value) => value.trim() === value && value !== '.' && value !== '..' && !/\p{Cc}/u.test(value));
const code = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/UAPKG-(?:BEGIN|END)/.test(value), 'Reserved UAPKG marker');
const sourceEdit = z
  .strictObject({
    select: z.union([z.literal('all'), z.array(unrealName).nonempty()]),
    includes: code.optional(),
    classBody: code.optional(),
    constructorBody: code.optional(),
  })
  .refine((edit) => !!(edit.includes || edit.classBody || edit.constructorBody), 'Supply C# to insert');

export const IntegrationDefinitionSchema = z.strictObject({
  setupProject: z.strictObject({ plugins: z.array(pluginName) }).optional(),
  setupModules: z.array(sourceEdit).optional(),
  setupTargets: z.array(sourceEdit).optional(),
});
export type IntegrationDefinition = z.infer<typeof IntegrationDefinitionSchema>;
export type SourceEdit = z.infer<typeof sourceEdit>;

export interface IntegrationInput {
  readonly workspaceRoot: string;
  /** Physical dependency roots reported by the installer, including custom paths. */
  readonly installedRoots?: readonly string[];
  readonly workspaceKind: 'project' | 'plugin';
  readonly directPlugins: readonly { owner: string; pluginName: string }[];
  readonly integrations: readonly { owner: string; definition: IntegrationDefinition }[];
  readonly complete: boolean;
  readonly retainOwners?: readonly string[];
}
