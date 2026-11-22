import { createHash } from 'node:crypto';

export function marginAccountKey(profile: string, user: string, mode: string): string {
  return createHash('sha256').update(`${profile}:${user}:${mode}:${mode === 'CROSS_EXCHANGE' ? 'CROSSEX' : 'all'}`).digest('hex');
}
