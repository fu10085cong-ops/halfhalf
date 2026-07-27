import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createImportJob,
  getImportJob,
  listImportJobs,
} from '../../src/engine/import-job-store.js';

test('job history is owner-scoped and omits heavy results until one job is opened', async () => {
  const owner = 'browser-client-a';
  const created = createImportJob({
    owner,
    fileName: '通用资料.pdf',
    sizeBytes: 123,
    task: async () => ({
      markdown: '# 可恢复内容',
      summary: {
        kind: 'pdf',
        originalName: '通用资料.pdf',
        sizeBytes: 123,
        characterCount: 6,
        paragraphCount: 1,
        headingCount: 1,
        tableCount: 0,
        imageCount: 0,
        warnings: [],
      },
    }),
  });

  let completed = getImportJob(created.jobId, owner);
  for (let attempt = 0; attempt < 20 && completed?.status !== 'completed'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = getImportJob(created.jobId, owner);
  }

  assert.equal(completed?.status, 'completed');
  assert.equal(completed?.result?.markdown, '# 可恢复内容');
  assert.equal(getImportJob(created.jobId, 'browser-client-b'), undefined);

  const history = listImportJobs(owner);
  const listed = history.find((job) => job.jobId === created.jobId);
  assert.equal(listed?.status, 'completed');
  assert.equal(listed?.result, undefined);
});

test('terminal history is bounded per owner', async () => {
  const owner = 'history-limit-owner';
  for (let index = 0; index < 22; index += 1) {
    const created = createImportJob({
      owner,
      fileName: `document-${index}.pdf`,
      sizeBytes: index,
      task: async () => ({
        markdown: `# ${index}`,
        summary: {
          kind: 'pdf',
          originalName: `document-${index}.pdf`,
          sizeBytes: index,
          characterCount: 1,
          paragraphCount: 1,
          headingCount: 1,
          tableCount: 0,
          imageCount: 0,
          warnings: [],
        },
      }),
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = getImportJob(created.jobId, owner);
      if (current?.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  const history = listImportJobs(owner, 100);
  assert.equal(history.length, 20);
  assert.equal(history[0]?.fileName, 'document-21.pdf');
  assert.equal(history.some((job) => job.fileName === 'document-0.pdf'), false);
});
