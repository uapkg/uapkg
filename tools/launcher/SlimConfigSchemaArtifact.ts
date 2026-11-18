import fs from 'node:fs';
import path from 'node:path';

/** Keep the embedded schema reproducible without touching an unchanged file. */
export function updateSlimConfigSchema(file: string, schema: Record<string, unknown>, check = false): boolean {
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  let actual: string | undefined;
  try {
    actual = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  if (actual === expected) return false;
  if (check) {
    throw new Error(`The embedded slim-config schema is missing or stale: ${file}. Run vp run launcher:schema.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, expected, 'utf8');
  return true;
}
