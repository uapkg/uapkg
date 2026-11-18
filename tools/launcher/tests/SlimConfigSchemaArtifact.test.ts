import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { updateSlimConfigSchema } from '../SlimConfigSchemaArtifact.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function artifact() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uapkg-slim-schema-'));
  roots.push(root);
  return path.join(root, 'generated', 'slim-config.schema.json');
}

describe('embedded slim-config schema artifact', () => {
  it('writes reproducible JSON and leaves an unchanged artifact untouched', () => {
    const file = artifact();
    const schema = { type: 'object', default: { launcher: { defaultCliVersion: 'latest' } } };
    expect(updateSlimConfigSchema(file, schema)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${JSON.stringify(schema, null, 2)}\n`);
    fs.utimesSync(file, new Date(1_000), new Date(1_000));
    expect(updateSlimConfigSchema(file, schema)).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(1_000);
    expect(updateSlimConfigSchema(file, schema, true)).toBe(false);
  });

  it('fails a missing or stale freshness check without writing files', () => {
    const file = artifact();
    expect(() => updateSlimConfigSchema(file, {}, true)).toThrow('vp run launcher:schema');
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    updateSlimConfigSchema(file, { type: 'object' });
    const before = fs.readFileSync(file);
    expect(() => updateSlimConfigSchema(file, { type: 'string' }, true)).toThrow('stale');
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
