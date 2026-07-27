import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { ImportedDocument } from '../types/index.js';

export type PersistedImportJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PersistedImportJobStage =
  | 'queued'
  | 'extracting'
  | 'rendering'
  | 'finalizing'
  | 'completed';

export interface PersistedImportJob {
  schemaVersion: 1;
  jobId: string;
  ownerKey: string;
  status: PersistedImportJobStatus;
  stage: PersistedImportJobStage;
  progress: number;
  message: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  result?: ImportedDocument;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface ImportJobRepository {
  readonly durable: boolean;
  load(): PersistedImportJob[];
  save(job: PersistedImportJob): void;
  delete(jobId: string): void;
}

export function recoverPersistedImportJob(
  record: PersistedImportJob,
  now = Date.now()
): PersistedImportJob {
  if (record.status !== 'queued' && record.status !== 'running') return record;
  const message = '\u670d\u52a1\u91cd\u542f\u4e2d\u65ad\u4e86\u672a\u5b8c\u6210\u7684\u89e3\u6790\u4efb\u52a1\uff0c\u8bf7\u91cd\u65b0\u63d0\u4ea4\u6587\u4ef6\u3002';
  return {
    ...record,
    status: 'failed',
    message,
    updatedAt: now,
    error: { code: 'IMPORT_INTERRUPTED', message },
  };
}

export class MemoryImportJobRepository implements ImportJobRepository {
  readonly durable = false;
  load(): PersistedImportJob[] {
    return [];
  }
  save(_job: PersistedImportJob): void {}
  delete(_jobId: string): void {}
}

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SAFE_JOB_ID = /^[a-f0-9-]{16,64}$/i;

function isPersistedImportJob(value: unknown): value is PersistedImportJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as Partial<PersistedImportJob>;
  return (
    job.schemaVersion === 1 &&
    typeof job.jobId === 'string' &&
    SAFE_JOB_ID.test(job.jobId) &&
    typeof job.ownerKey === 'string' &&
    typeof job.status === 'string' &&
    typeof job.stage === 'string' &&
    typeof job.progress === 'number' &&
    typeof job.message === 'string' &&
    typeof job.fileName === 'string' &&
    typeof job.sizeBytes === 'number' &&
    typeof job.createdAt === 'number' &&
    typeof job.updatedAt === 'number'
  );
}

export class FileImportJobRepository implements ImportJobRepository {
  readonly durable = true;
  readonly directory: string;

  constructor(rootDirectory: string) {
    this.directory = path.join(path.resolve(rootDirectory), 'import-jobs');
    mkdirSync(this.directory, { recursive: true });
  }

  load(): PersistedImportJob[] {
    const jobs: PersistedImportJob[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const absolutePath = path.join(this.directory, entry.name);
      try {
        if (statSync(absolutePath).size > MAX_SNAPSHOT_BYTES) continue;
        const parsed: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'));
        if (isPersistedImportJob(parsed)) jobs.push(parsed);
      } catch {
        // One damaged snapshot must not prevent the service from starting.
      }
    }
    return jobs.sort((left, right) => left.createdAt - right.createdAt);
  }

  save(job: PersistedImportJob): void {
    if (!SAFE_JOB_ID.test(job.jobId)) throw new Error('Invalid import job id.');
    const target = path.join(this.directory, `${job.jobId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(job), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, target);
  }

  delete(jobId: string): void {
    if (!SAFE_JOB_ID.test(jobId)) return;
    rmSync(path.join(this.directory, `${jobId}.json`), { force: true });
  }
}

export function createImportJobRepository(
  dataDirectory = process.env.HALFHALF_DATA_DIR?.trim()
): ImportJobRepository {
  return dataDirectory
    ? new FileImportJobRepository(dataDirectory)
    : new MemoryImportJobRepository();
}
