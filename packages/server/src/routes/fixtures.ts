/**
 * 测试材料速载（开发用）：把 packages/server/test/fixtures/*.md 列给前端下拉加载，
 * 省去"翻文件夹→复制→粘贴"的手工搬运，让网页端直接当引擎测试台用。
 * 生产环境一律 404——fixtures 里是个人真实复习材料，且 API 尚无访问门槛（部署清单）。
 */
import { Router, Request, Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApiErrorResponse } from '../types/index.js';

export const fixturesRouter: Router = Router();

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../test/fixtures'
);

function guardProd(res: Response): boolean {
  if (process.env.NODE_ENV === 'production') {
    res.status(404).json({ error: '生产环境不提供测试材料接口' } satisfies ApiErrorResponse);
    return true;
  }
  return false;
}

fixturesRouter.get('/fixtures', async (_req: Request, res: Response) => {
  if (guardProd(res)) return;
  try {
    const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.md')).sort();
    const fixtures = await Promise.all(
      files.map(async (name) => {
        const stat = await fs.stat(path.join(FIXTURES_DIR, name));
        return { name, sizeKb: Math.round(stat.size / 102.4) / 10 };
      })
    );
    res.json({ fixtures });
  } catch (err) {
    res.status(500).json({ error: `读取 fixtures 失败: ${String(err)}` } satisfies ApiErrorResponse);
  }
});

fixturesRouter.get('/fixtures/:name', async (req: Request, res: Response) => {
  if (guardProd(res)) return;
  const name = req.params.name;
  // 白名单字符 + 禁止路径穿越；resolve 后再验一次前缀，双保险
  if (!/^[\w.-]+\.md$/.test(name) || name.includes('..')) {
    res.status(400).json({ error: '非法文件名' } satisfies ApiErrorResponse);
    return;
  }
  const abs = path.resolve(FIXTURES_DIR, name);
  if (!abs.startsWith(FIXTURES_DIR + path.sep)) {
    res.status(400).json({ error: '非法文件名' } satisfies ApiErrorResponse);
    return;
  }
  try {
    const markdown = await fs.readFile(abs, 'utf-8');
    res.json({ name, markdown });
  } catch {
    res.status(404).json({ error: `fixture 不存在: ${name}` } satisfies ApiErrorResponse);
  }
});
