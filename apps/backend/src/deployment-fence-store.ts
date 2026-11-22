import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const LeaseSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/),
  leaseToken: z.string().uuid(),
  generation: z.number().int().positive(),
  handoff: z.object({ originalMode: z.enum(['unset', 'readonly', 'live', 'protect_only']),
    controlStamp: z.string().min(1), ready: z.boolean(), sourceBootId: z.string().uuid().optional(),
    sourceRevision: z.string().min(1).optional(), targetRevision: z.string().min(1).optional() }).strict().optional(),
}).strict();
export type DeploymentLease = z.infer<typeof LeaseSchema>;
const CompletionSchema = z.object({ lease: LeaseSchema, outcome: z.enum(['cancelled', 'committed']), completedAt: z.number(),
  runtime: z.object({ bootId: z.string().uuid(), revision: z.string().min(1) }).strict().optional() }).strict();
export type DeploymentCompletion = z.infer<typeof CompletionSchema>;
const RecordSchema = z.object({ schema: z.literal(1), lease: LeaseSchema.nullable(), completion: CompletionSchema.optional() }).strict();

/** Private evidence shares the application's single-process data-directory ownership. */
export class DeploymentFenceStore {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }

  private checkPath(): void {
    let current = this.path;
    for (;;) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('deployment_store_link_forbidden');
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  load(): DeploymentLease | null {
    this.checkPath();
    if (!existsSync(this.path)) return null;
    return RecordSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))).lease;
  }

  completion(): DeploymentCompletion | undefined {
    this.checkPath();
    return existsSync(this.path) ? RecordSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))).completion : undefined;
  }

  save(lease: DeploymentLease | null, completion?: DeploymentCompletion): void {
    this.checkPath();
    const value = RecordSchema.parse({ schema: 1, lease, completion });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, this.path);
    if (process.platform !== 'win32') {
      const folder = openSync(dirname(this.path), 'r');
      try { fsyncSync(folder); } finally { closeSync(folder); }
    }
  }
}
