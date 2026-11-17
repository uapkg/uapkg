import { writeSync } from 'node:fs';
import { z } from 'zod';

const noticesSchema = z
  .object({
    schemaVersion: z.literal(1),
    messages: z
      .array(
        z
          .string()
          .min(1)
          .max(2_048)
          .refine((value) => {
            for (let index = 0; index < value.length; index += 1) {
              const code = value.charCodeAt(index);
              if (code < 32 || code === 127) return false;
            }
            return true;
          }),
      )
      .max(8),
  })
  .strict();

/** Consume once so nested CLI processes cannot repeat their parent's notices. */
export function registerLauncherNoticeFooter(): void {
  const raw = process.env.UAPKG_LAUNCHER_NOTICES;
  delete process.env.UAPKG_LAUNCHER_NOTICES;
  let messages: string[] = [];
  if (raw && raw.length <= 16_384) {
    try {
      const result = noticesSchema.safeParse(JSON.parse(raw));
      if (result.success) messages = [...new Set(result.data.messages)];
    } catch {
      /* Malformed inherited context must not change command behavior. */
    }
  }
  if (messages.length === 0) return;
  process.once('exit', () => {
    // Run after bootstrap reports command errors. Synchronous stderr writes
    // also work when the argument parser exits without returning.
    try {
      writeSync(2, `\n${messages.map((message) => `uapkg: ${message}\n`).join('')}`);
    } catch {
      /* Preserve command status when stderr is closed. */
    }
  });
}
