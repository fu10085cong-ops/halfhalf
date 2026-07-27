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

/**
 * 任务快照刻意不含 result：完成结果里嵌着整页 base64 图，动辄几 MB。
 * 快照小才能在启动时全部读进内存，结果按需单独取（见 loadResult）。
 */
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
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface ImportJobRepository {
  readonly durable: boolean;
  load(): PersistedImportJob[];
  save(job: PersistedImportJob): void;
  /** 完成结果单独落盘，不进快照——避免启动时把所有页面图读进内存。 */
  saveResult(jobId: string, result: ImportedDocument): void;
  loadResult(jobId: string): ImportedDocument | undefined;
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
  saveResult(_jobId: string, _result: ImportedDocument): void {}
  loadResult(_jobId: string): ImportedDocument | undefined {
    return undefined;
  }
  delete(_jobId: string): void {}
}

/** 快照不含结果，正常只有几百字节；给一个宽松上限挡住被写坏的文件。 */
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
/** 结果含整页 base64 图，单个任务的天花板。 */
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const SAFE_JOB_ID = /^[a-f0-9-]{16,64}$/i;

function isImportedDocument(value: unknown): value is ImportedDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Partial<ImportedDocument>;
  return typeof document.markdown === 'string' && Boolean(document.summary);
}

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

  private snapshotPath(jobId: string): string {
    return path.join(this.directory, `${jobId}.json`);
  }

  private resultPath(jobId: string): string {
    return path.join(this.directory, `${jobId}.result.json`);
  }

  /** 原子写：先写唯一临时文件再 rename，半截文件不会被后续读到。 */
  private writeAtomically(target: string, payload: string): void {
    const temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, target);
  }

  load(): PersistedImportJob[] {
    const jobs: PersistedImportJob[] = [];
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      // .result.json 是结果载荷，按需单独读，不在启动时扫进内存
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      if (entry.name.endsWith('.result.json')) continue;
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
    this.writeAtomically(this.snapshotPath(job.jobId), JSON.stringify(job));
  }

  saveResult(jobId: string, result: ImportedDocument): void {
    if (!SAFE_JOB_ID.test(jobId)) throw new Error('Invalid import job id.');
    const payload = JSON.stringify(result);
    // 写得进去却读不回来最糟：超限直接不写，让任务退化成「有记录、无结果」
    if (Buffer.byteLength(payload, 'utf8') > MAX_RESULT_BYTES) {
      throw new Error(`Import result exceeds ${MAX_RESULT_BYTES} bytes and was not persisted.`);
    }
    this.writeAtomically(this.resultPath(jobId), payload);
  }

  loadResult(jobId: string): ImportedDocument | undefined {
    if (!SAFE_JOB_ID.test(jobId)) return undefined;
    const absolutePath = this.resultPath(jobId);
    try {
      if (statSync(absolutePath).size > MAX_RESULT_BYTES) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'));
      return isImportedDocument(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  delete(jobId: string): void {
    if (!SAFE_JOB_ID.test(jobId)) return;
    rmSync(this.snapshotPath(jobId), { force: true });
    rmSync(this.resultPath(jobId), { force: true });
  }
}

export function createImportJobRepository(
  dataDirectory = process.env.HALFHALF_DATA_DIR?.trim()
): ImportJobRepository {
  return dataDirectory
    ? new FileImportJobRepository(dataDirectory)
    : new MemoryImportJobRepository();
}
