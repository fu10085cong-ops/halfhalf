import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  FileImportJobRepository,
  MemoryImportJobRepository,
  recoverPersistedImportJob,
  type PersistedImportJob,
} from '../../src/engine/import-job-repository.js';

function sampleJob(overrides: Partial<PersistedImportJob> = {}): PersistedImportJob {
  return {
    schemaVersion: 1,
    jobId: '18ed86a0-4699-4d84-9e23-c598e229bdde',
    ownerKey: 'c'.repeat(64),
    status: 'completed',
    stage: 'completed',
    progress: 100,
    message: '解析完成',
    fileName: '一般资料.pdf',
    sizeBytes: 1234,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

test('memory repository keeps the Phase 3 zero-configuration behavior', () => {
  const repository = new MemoryImportJobRepository();
  assert.equal(repository.durable, false);
  repository.save(sampleJob());
  assert.deepEqual(repository.load(), []);
});

test('file repository atomically persists, reloads, and deletes job snapshots', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'halfhalf-job-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repository = new FileImportJobRepository(root);
  const job = sampleJob({
    result: {
      markdown: '# 可恢复结果',
      summary: {
        kind: 'pdf',
        originalName: '一般资料.pdf',
        sizeBytes: 1234,
        characterCount: 6,
        paragraphCount: 1,
        headingCount: 1,
        tableCount: 0,
        imageCount: 0,
        warnings: [],
      },
    },
  });

  repository.save(job);
  assert.deepEqual(new FileImportJobRepository(root).load(), [job]);

  repository.delete(job.jobId);
  assert.deepEqual(repository.load(), []);
});

test('one damaged snapshot does not prevent valid job history from loading', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'halfhalf-job-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const repository = new FileImportJobRepository(root);
  const job = sampleJob();
  repository.save(job);
  writeFileSync(path.join(repository.directory, 'damaged.json'), '{broken', 'utf8');

  assert.deepEqual(repository.load(), [job]);
});

test('repository rejects unsafe job ids before creating a path', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'halfhalf-job-repository-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = new FileImportJobRepository(root);

  assert.throws(
    () => repository.save(sampleJob({ jobId: '../../outside' })),
    /Invalid import job id/
  );
});

test('restart recovery keeps terminal results and marks active jobs as interrupted', () => {
  const completed = sampleJob();
  assert.equal(recoverPersistedImportJob(completed), completed);

  const running = sampleJob({
    status: 'running',
    stage: 'rendering',
    progress: 65,
    updatedAt: 150,
  });
  const recovered = recoverPersistedImportJob(running, 999);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.stage, 'rendering');
  assert.equal(recovered.updatedAt, 999);
  assert.equal(recovered.error?.code, 'IMPORT_INTERRUPTED');
});
