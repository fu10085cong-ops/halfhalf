/** 访问口令中间件的三态锁：无口令 401 / 错口令 401 / 对口令放行；health 永远放行 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response, NextFunction } from 'express';
import { accessCodeGuard } from '../../src/middleware/access-code.js';

function fakeCtx(path: string, code?: string) {
  const state = { status: 0, body: undefined as unknown, nexted: false };
  const req = {
    path,
    headers: code === undefined ? {} : { 'x-access-code': code },
  } as unknown as Request;
  const res = {
    status(s: number) {
      state.status = s;
      return this;
    },
    json(b: unknown) {
      state.body = b;
      return this;
    },
  } as unknown as Response;
  const next: NextFunction = () => {
    state.nexted = true;
  };
  return { req, res, next, state };
}

const guard = accessCodeGuard('correct-horse');

test('无口令 → 401', () => {
  const { req, res, next, state } = fakeCtx('/scene');
  guard(req, res, next);
  assert.equal(state.status, 401);
  assert.equal(state.nexted, false);
});

test('错口令（含长度不同）→ 401', () => {
  for (const wrong of ['wrong', 'correct-horsE', 'correct-horse-battery']) {
    const { req, res, next, state } = fakeCtx('/scene', wrong);
    guard(req, res, next);
    assert.equal(state.status, 401, `口令 ${wrong} 应被拒`);
    assert.equal(state.nexted, false);
  }
});

test('对口令 → 放行', () => {
  const { req, res, next, state } = fakeCtx('/scene', 'correct-horse');
  guard(req, res, next);
  assert.equal(state.nexted, true);
  assert.equal(state.status, 0);
});

test('/health 无口令也放行（探活）', () => {
  const { req, res, next, state } = fakeCtx('/health');
  guard(req, res, next);
  assert.equal(state.nexted, true);
});
