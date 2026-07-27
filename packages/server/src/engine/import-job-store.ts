import { createHash, randomUUID } from 'node:crypto';
import type { ImportedDocument } from '../types/index.js';
import {
  createImportJobRepository,
  recoverPersistedImportJob,
  type PersistedImportJob,
} from './import-job-repository.js';

export type ImportJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ImportJobStage = 'queued' | 'extracting' | 'rendering' | 'finalizing' | 'completed';

export interface ImportJobProgress {
  progress: number;
  stage: ImportJobStage;
  message: string;
}

export interface ImportJobSnapshot extends ImportJobProgress {
  jobId: string;
  status: ImportJobStatus;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  result?: ImportedDocument;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

interface ImportJob extends ImportJobProgress {
  id: string;
  ownerKey: string;
  status: ImportJobStatus;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  controller: AbortController;
  task?: ImportJobTask;
  result?: ImportedDocument;
  error?: ImportJobSnapshot['error'];
}

export type ImportJobTask = (
  signal: AbortSignal,
  report: (progress: ImportJobProgress) => void
) => Promise<ImportedDocument>;

export class ImportQueueError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 429
  ) {
    super(message);
    this.name = 'ImportQueueError';
  }
}

const JOB_TTL_MS = Number(process.env.HALFHALF_IMPORT_JOB_TTL_MS) || 30 * 60 * 1000;
const GLOBAL_CONCURRENCY = Math.max(
  1,
  Math.min(4, Number(process.env.HALFHALF_IMPORT_CONCURRENCY) || 1)
);
const OWNER_ACTIVE_LIMIT = Math.max(
  1,
  Math.min(10, Number(process.env.HALFHALF_IMPORT_OWNER_LIMIT) || 3)
);
const GLOBAL_ACTIVE_LIMIT = Math.max(
  OWNER_ACTIVE_LIMIT,
  Math.min(100, Number(process.env.HALFHALF_IMPORT_GLOBAL_LIMIT) || 20)
);
const OWNER_HISTORY_LIMIT = Math.max(
  1,
  Math.min(100, Number(process.env.HALFHALF_IMPORT_HISTORY_LIMIT) || 20)
);

const repository = createImportJobRepository();
const jobs = new Map<string, ImportJob>();
const queue: string[] = [];
let runningCount = 0;

function ownerKey(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isActive(job: ImportJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function snapshot(job: ImportJob, includeResult = true): ImportJobSnapshot {
  return {
    jobId: job.id,
    status: job.status,
    fileName: job.fileName,
    sizeBytes: job.sizeBytes,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    ...(includeResult && job.status === 'completed' && job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function persistedSnapshot(job: ImportJob): PersistedImportJob {
  return {
    schemaVersion: 1,
    jobId: job.id,
    ownerKey: job.ownerKey,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    fileName: job.fileName,
    sizeBytes: job.sizeBytes,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.status === 'completed' && job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function persist(job: ImportJob): void {
  try {
    repository.save(persistedSnapshot(job));
  } catch (error) {
    console.error(
      `[halfhalf] import job ${job.id} persistence failed:`,
      error instanceof Error ? error.message : error
    );
  }
}

function cleanupExpiredJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (!isActive(job) && now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
      repository.delete(id);
    }
  }
}

function pruneOwnerHistory(key: string): void {
  const terminal = [...jobs.values()]
    .filter((job) => job.ownerKey === key && !isActive(job))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  for (const job of terminal.slice(OWNER_HISTORY_LIMIT)) {
    jobs.delete(job.id);
    repository.delete(job.id);
  }
}

function report(job: ImportJob, value: ImportJobProgress): void {
  if (job.status !== 'running') return;
  job.progress = clampProgress(value.progress);
  job.stage = value.stage;
  job.message = value.message;
  job.updatedAt = Date.now();
  persist(job);
}

function normalizeFailure(error: unknown): NonNullable<ImportJobSnapshot['error']> {
  if (error && typeof error === 'object') {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      details?: unknown;
    };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'IMPORT_FAILED',
      message:
        typeof candidate.message === 'string'
          ? candidate.message
          : '\u6587\u6863\u89e3\u6790\u5931\u8d25\u3002',
      ...(candidate.details && typeof candidate.details === 'object'
        ? { details: candidate.details as Record<string, unknown> }
        : {}),
    };
  }
  return { code: 'IMPORT_FAILED', message: String(error) };
}

async function runJob(job: ImportJob): Promise<void> {
  if (!job.task) {
    job.status = 'failed';
    job.error = {
      code: 'IMPORT_INTERRUPTED',
      message: '\u670d\u52a1\u91cd\u542f\u4e2d\u65ad\u4e86\u672a\u5b8c\u6210\u7684\u89e3\u6790\u4efb\u52a1\uff0c\u8bf7\u91cd\u65b0\u63d0\u4ea4\u6587\u4ef6\u3002',
    };
    job.message = job.error.message;
    job.updatedAt = Date.now();
    persist(job);
    return;
  }
  runningCount += 1;
  job.status = 'running';
  report(job, {
    progress: 5,
    stage: 'extracting',
    message: '\u6b63\u5728\u89e3\u6790\u6587\u6863\u7ed3\u6784\u2026',
  });
  try {
    const result = await job.task(job.controller.signal, (value) => report(job, value));
    if (job.controller.signal.aborted) return;
    job.result = result;
    job.status = 'completed';
    job.progress = 100;
    job.stage = 'completed';
    job.message = '\u89e3\u6790\u5b8c\u6210';
    job.updatedAt = Date.now();
    persist(job);
  } catch (error) {
    if (job.controller.signal.aborted) {
      job.status = 'cancelled';
      job.message = '\u5df2\u53d6\u6d88';
    } else {
      job.status = 'failed';
      const failure = normalizeFailure(error);
      job.error = failure;
      job.message = failure.message;
    }
    job.updatedAt = Date.now();
    persist(job);
  } finally {
    pruneOwnerHistory(job.ownerKey);
    runningCount = Math.max(0, runningCount - 1);
    queueMicrotask(pumpQueue);
  }
}

function pumpQueue(): void {
  cleanupExpiredJobs();
  while (runningCount < GLOBAL_CONCURRENCY && queue.length > 0) {
    const id = queue.shift();
    if (!id) break;
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') continue;
    void runJob(job);
  }
}

export function createImportJob(input: {
  owner: string;
  fileName: string;
  sizeBytes: number;
  task: ImportJobTask;
}): ImportJobSnapshot {
  cleanupExpiredJobs();
  const active = [...jobs.values()].filter(isActive);
  const inputOwnerKey = ownerKey(input.owner);
  if (active.filter((job) => job.ownerKey === inputOwnerKey).length >= OWNER_ACTIVE_LIMIT) {
    throw new ImportQueueError(
      'IMPORT_OWNER_LIMIT',
      `\u540c\u4e00\u7528\u6237\u6700\u591a\u540c\u65f6\u4fdd\u7559 ${OWNER_ACTIVE_LIMIT} \u4e2a\u89e3\u6790\u4efb\u52a1\uff0c\u8bf7\u7a0d\u540e\u518d\u8bd5\u3002`
    );
  }
  if (active.length >= GLOBAL_ACTIVE_LIMIT) {
    throw new ImportQueueError(
      'IMPORT_QUEUE_FULL',
      '\u670d\u52a1\u5668\u89e3\u6790\u961f\u5217\u5df2\u6ee1\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002'
    );
  }

  const now = Date.now();
  const job: ImportJob = {
    id: randomUUID(),
    ownerKey: inputOwnerKey,
    status: 'queued',
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    progress: 0,
    stage: 'queued',
    message: '\u5df2\u8fdb\u5165\u89e3\u6790\u961f\u5217',
    createdAt: now,

    updatedAt: now,
    controller: new AbortController(),
    task: input.task,
  };
  jobs.set(job.id, job);
  persist(job);
  queue.push(job.id);
  queueMicrotask(pumpQueue);
  return snapshot(job);
}

export function getImportJob(jobId: string, owner: string): ImportJobSnapshot | undefined {
  cleanupExpiredJobs();
  const job = jobs.get(jobId);
  return job && job.ownerKey === ownerKey(owner) ? snapshot(job) : undefined;
}

export function listImportJobs(owner: string, limit = 20): ImportJobSnapshot[] {
  cleanupExpiredJobs();
  const key = ownerKey(owner);
  return [...jobs.values()]
    .filter((job) => job.ownerKey === key)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((job) => snapshot(job, false));
}

export function cancelImportJob(jobId: string, owner: string): ImportJobSnapshot | undefined {
  const job = jobs.get(jobId);
  if (!job || job.ownerKey !== ownerKey(owner)) return undefined;
  if (job.status === 'queued' || job.status === 'running') {
    job.controller.abort();
    job.status = 'cancelled';
    job.message = '\u5df2\u53d6\u6d88';
    job.updatedAt = Date.now();
    persist(job);
  }
  return snapshot(job);
}

/**
 * 同步导入端点（/api/import/document，Studio 与旧拖放都在用）跟异步队列共享
 * 同一份并发预算：它同样会拉起 pdfjs 解析和 PyMuPDF 子进程，不能绕过闸门，
 * 否则 concurrency=1 的小内存机器可以被并发同步请求打爆。
 */
export function tryAcquireImportSlot(): boolean {
  cleanupExpiredJobs();
  if (runningCount >= GLOBAL_CONCURRENCY) return false;
  runningCount += 1;
  return true;
}

export function releaseImportSlot(): void {
  runningCount = Math.max(0, runningCount - 1);
  queueMicrotask(pumpQueue);
}

export const importQueueLimits = {
  concurrency: GLOBAL_CONCURRENCY,
  perOwner: OWNER_ACTIVE_LIMIT,
  global: GLOBAL_ACTIVE_LIMIT,
  historyPerOwner: OWNER_HISTORY_LIMIT,
  ttlMs: JOB_TTL_MS,
  durable: repository.durable,
};

function hydratePersistedJobs(): void {
  const now = Date.now();
  for (const record of repository.load()) {
    if (
      record.status !== 'queued' &&
      record.status !== 'running' &&
      now - record.updatedAt > JOB_TTL_MS
    ) {
      repository.delete(record.jobId);
      continue;
    }

    const recovered = recoverPersistedImportJob(record, now);
    const job: ImportJob = {
      id: recovered.jobId,
      ownerKey: recovered.ownerKey,
      status: recovered.status,
      stage: recovered.stage,
      progress: recovered.progress,
      message: recovered.message,
      fileName: recovered.fileName,
      sizeBytes: recovered.sizeBytes,
      createdAt: recovered.createdAt,
      updatedAt: recovered.updatedAt,
      controller: new AbortController(),
      ...(recovered.result ? { result: recovered.result } : {}),
      ...(recovered.error ? { error: recovered.error } : {}),
    };
    jobs.set(job.id, job);
    if (recovered !== record) persist(job);
  }
  for (const key of new Set([...jobs.values()].map((job) => job.ownerKey))) {
    pruneOwnerHistory(key);
  }
}

hydratePersistedJobs();
