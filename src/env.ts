/**
 * src/env — minimal runtime env for the valar agent (valinor).
 *
 * The agent reads its model/provider/path config directly from `process.env.VALAR_*`
 * at the call sites (see tui.ts). This module only validates the two values the logger
 * needs, both with safe defaults — so a fresh checkout boots with zero env set.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  cached = parsed.success ? parsed.data : { LOG_LEVEL: 'info', NODE_ENV: 'development' };
  return cached;
}
