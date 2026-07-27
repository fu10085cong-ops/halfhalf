/**
 * 联网补洞的提交端点。
 *
 * 只新增提交，不新增查询——研究任务与导入任务共用同一个 job store，
 * 查进度/取详情/取消/列历史全部走既有的 /api/import/jobs/*。
 * 两类任务在同一条队列里排队、共享并发额度：它们抢的是同一份 CPU 和内存。
 */
import { Router, type Request } from 'express';
import type { AiProviderConfig } from '../types/index.js';
import { ResearchError, runResearch } from '../engine/research-pipeline.js';
import { createSearchProvider } from '../engine/search-provider.js';
import { createImportJob, ImportQueueError } from '../engine/import-job-store.js';

export const researchRouter: Router = Router();

const MAX_QUERY_CHARS = 200;

function researchOwner(req: Request): string {
  const header = req.get('x-halfhalf-client')?.trim().slice(0, 128);
  return header || req.ip || 'anonymous';
}

researchRouter.post('/research/jobs', (req, res) => {
  const body = req.body as { query?: unknown; provider?: AiProviderConfig };
  const query = typeof body?.query === 'string' ? body.query.trim() : '';

  if (!query) {
    res.status(400).json({ code: 'RESEARCH_EMPTY_QUERY', error: '请先填写要检索的关键词。' });
    return;
  }
  if (query.length > MAX_QUERY_CHARS) {
    res.status(400).json({
      code: 'RESEARCH_QUERY_TOO_LONG',
      error: `检索关键词不能超过 ${MAX_QUERY_CHARS} 字。`,
    });
    return;
  }

  // 没配搜索 key 就在这里挡住。绝不放行到「让模型凭记忆写一段」那条路上
  const searchProvider = createSearchProvider();
  if (!searchProvider) {
    res.status(501).json({
      code: 'RESEARCH_UNAVAILABLE',
      error: '服务器未配置检索能力（HALFHALF_SEARCH_KEY）。',
    });
    return;
  }

  try {
    const job = createImportJob({
      owner: researchOwner(req),
      fileName: query.slice(0, 60),
      sizeBytes: Buffer.byteLength(query, 'utf8'),
      task: async (signal, report) =>
        runResearch(query, searchProvider, {
          signal,
          onProgress: report,
          ...(body.provider ? { provider: body.provider } : {}),
        }),
    });
    res.status(202).json(job);
  } catch (error) {
    if (error instanceof ImportQueueError) {
      res.status(error.status).json({ code: error.code, error: error.message });
      return;
    }
    if (error instanceof ResearchError) {
      res.status(error.status).json({
        code: error.code,
        error: error.message,
        details: error.details,
      });
      return;
    }
    res.status(500).json({
      code: 'RESEARCH_JOB_CREATE_FAILED',
      error: error instanceof Error ? error.message : '无法创建检索任务。',
    });
  }
});
