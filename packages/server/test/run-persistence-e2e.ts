/**
 * 异步导入任务持久化的端到端验证 —— **门禁型**（强度定义见仓库根 TESTING.md §3）：
 * 任一环节不符即抛错退出。要真起一次服务、真跑一份 PDF/DOCX，所以不进 `pnpm test`，
 * 需要你手动给一份材料：pnpm test:persistence -- <path-to-pdf-or-docx>
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const input = process.argv.slice(2).find((argument) => argument !== '--');
if (!input) {
  console.error('Usage: pnpm test:persistence -- <path-to-pdf-or-docx>');
  process.exit(2);
}

const root = path.resolve(import.meta.dirname, '../../..');
const dataDirectory = await mkdtemp(path.join(tmpdir(), 'halfhalf-persistence-e2e-'));
const port = 3199;
const baseUrl = `http://127.0.0.1:${port}`;
const clientId = 'persistence-e2e-client';
let server: ChildProcess | undefined;

function startServer(): ChildProcess {
  const child = spawn(process.execPath, ['packages/server/dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HALFHALF_DATA_DIR: dataDirectory,
      HALFHALF_PYTHON:
        process.env.HALFHALF_PYTHON ??
        path.join(root, '.venv-parser', 'Scripts', 'python.exe'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', () => undefined);
  return child;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Persistence E2E server did not become healthy.');
}

async function getJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url, {
    headers: { 'x-halfhalf-client': clientId },
  });
  const body = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body;
}

try {
  server = startServer();
  await waitForHealth();

  const absoluteInput = path.resolve(input);
  const bytes = await readFile(absoluteInput);
  const form = new FormData();
  form.append('file', new Blob([bytes]), path.basename(absoluteInput));
  const createResponse = await fetch(`${baseUrl}/api/import/jobs`, {
    method: 'POST',
    headers: { 'x-halfhalf-client': clientId },
    body: form,
  });
  const created = await createResponse.json() as Record<string, any>;
  if (!createResponse.ok || !created.jobId) {
    throw new Error(`Unable to create import job: ${JSON.stringify(created)}`);
  }

  let completed = created;
  for (
    let attempt = 0;
    attempt < 120 && ['queued', 'running'].includes(completed.status);
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    completed = await getJson(`${baseUrl}/api/import/jobs/${created.jobId}`);
  }
  if (completed.status !== 'completed') {
    throw new Error(`Import did not complete: ${JSON.stringify(completed)}`);
  }

  await stopServer(server);
  server = startServer();
  await waitForHealth();

  const history = await getJson(`${baseUrl}/api/import/jobs?limit=5`);
  const restored = await getJson(`${baseUrl}/api/import/jobs/${created.jobId}`);
  const historyJob = history.jobs?.find(
    (job: Record<string, any>) => job.jobId === created.jobId
  );
  if (!historyJob || historyJob.result) {
    throw new Error('History must contain lightweight metadata without the full result.');
  }
  if (restored.status !== 'completed' || !restored.result) {
    throw new Error('Completed result was not restored after restart.');
  }

  console.log(JSON.stringify({
    jobId: created.jobId,
    beforeRestart: completed.status,
    afterRestart: restored.status,
    historyCount: history.jobs.length,
    historyEmbedsResult: Boolean(historyJob.result),
    restoredPages: restored.result.summary.pageCount,
    restoredNodes: restored.result.knowledge?.nodes?.length ?? 0,
  }, null, 2));
} finally {
  if (server) await stopServer(server);
  await rm(dataDirectory, { recursive: true, force: true });
}
