import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMineruClient,
  MineruClient,
  MineruError,
  type MineruFetch,
} from '../../src/engine/mineru-client.js';

function captureFetch(responder: (url: string, init?: RequestInit) => Response): { fetcher: MineruFetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  return {
    calls,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  };
}

test('submits a document to the configured sidecar and returns its task id', async () => {
  const capture = captureFetch(() => Response.json({ task_id: 'task-42', status: 'queued', queued_ahead: 2 }));
  const client = new MineruClient({ baseUrl: 'http://127.0.0.1:8000/' }, capture.fetcher);

  const task = await client.submit({ bytes: Buffer.from('%PDF'), filename: 'lecture.pdf', contentType: 'application/pdf' });

  assert.equal(task.taskId, 'task-42');
  assert.equal(task.status, 'queued');
  assert.equal(task.queuedAhead, 2);
  assert.equal(capture.calls[0].url, 'http://127.0.0.1:8000/tasks');
  assert.equal(capture.calls[0].init?.method, 'POST');
  const form = capture.calls[0].init?.body as FormData;
  assert.equal(form.get('backend'), 'pipeline');
  assert.equal(form.get('parse_method'), 'auto');
  assert.equal(form.get('lang_list'), 'ch');
  assert.equal(form.get('return_md'), 'true');
  assert.equal((form.get('files') as File).name, 'lecture.pdf');
});

test('reads health and task status without assuming MinerU status vocabulary', async () => {
  const capture = captureFetch((url) =>
    url.endsWith('/health')
      ? Response.json({ protocol_version: '3', max_concurrent_requests: 1 })
      : Response.json({ task_id: 'wait/1', status: 'processing', extra: true })
  );
  const client = new MineruClient({ baseUrl: 'http://mineru.internal' }, capture.fetcher);

  assert.equal((await client.health()).protocol_version, '3');
  const task = await client.task('wait/1');
  assert.equal(task.taskId, 'wait/1');
  assert.equal(task.status, 'processing');
  assert.equal(capture.calls[1].url, 'http://mineru.internal/tasks/wait%2F1');
});

test('returns raw result bytes and preserves its content type', async () => {
  const capture = captureFetch(() => new Response('zip payload', { headers: { 'content-type': 'application/zip' } }));
  const client = new MineruClient({ baseUrl: 'https://mineru.internal' }, capture.fetcher);

  const result = await client.result('done');

  assert.equal(result.contentType, 'application/zip');
  assert.equal(Buffer.from(result.bytes).toString(), 'zip payload');
});

test('rejects malformed or incomplete upstream responses explicitly', async () => {
  const incomplete = new MineruClient({ baseUrl: 'http://mineru.internal' }, async () => Response.json({ status: 'queued' }));
  await assert.rejects(() => incomplete.submit({ bytes: Buffer.from('x'), filename: 'x.pdf' }), (error: unknown) =>
    error instanceof MineruError && error.code === 'MINERU_PROTOCOL_ERROR'
  );

  const rejected = new MineruClient({ baseUrl: 'http://mineru.internal' }, async () => new Response('not ready', { status: 503 }));
  await assert.rejects(() => rejected.health(), (error: unknown) =>
    error instanceof MineruError && error.code === 'MINERU_REJECTED' && error.status === 502
  );
});

test('is disabled unless the trusted deployment config enables it', () => {
  const previous = process.env.HALFHALF_MINERU_API_URL;
  delete process.env.HALFHALF_MINERU_API_URL;
  assert.equal(createMineruClient(), null);
  process.env.HALFHALF_MINERU_API_URL = 'http://127.0.0.1:8000';
  assert.ok(createMineruClient());
  if (previous === undefined) delete process.env.HALFHALF_MINERU_API_URL;
  else process.env.HALFHALF_MINERU_API_URL = previous;
});
