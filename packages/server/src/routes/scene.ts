/**
 * POST /api/scene —— 场景排版一站式接口（网格引擎）：
 * 分块 → 内容统计 → 场景推荐（或用户指定）→ 公式预检 → 网格字号搜索 → 渲染 PDF。
 * PDF 存进 job-store，前端用现有的 GET /api/download/:jobId/pdf 取。
 *
 * 图片：web 场景图片以 data: URI 直接内嵌在 Markdown 里（粘贴/上传时由前端转好），
 * md-to-html 对 data:/http(s): 原样透传，所以这里不需要 imageBaseDir。
 */
import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { ApiErrorResponse, ResolvedOrientation } from '../types/index.js';
import { DEFAULT_MARGINS } from '../types/index.js';
import { chunkMarkdown } from '../engine/chunk-markdown.js';
import { SCENE_PRESETS, analyzeContent, type SceneId } from '../engine/scene-presets.js';
import { deriveLayoutParams } from '../engine/rule-engine.js';
import { SUBJECT_RULES, suggestSubject } from '../engine/subject-rules.js';
import { renderGridPdf, searchGridFontSize } from '../engine/grid-layout.js';
import { precheckFormulas } from '../engine/precheck-formulas.js';
import { derivePdfName } from '../engine/pdf-name.js';
import { saveJob } from '../engine/job-store.js';

export const sceneRouter: Router = Router();

interface SceneRequest {
  markdown: string;
  targetPages?: number;
  /** 'auto'（默认）= 按内容特征推荐；也可指定四个预设之一 */
  scene?: SceneId | 'auto';
  orientation?: ResolvedOrientation;
  /** true = PDF 上叠加网格线/块方框/标签，用于目视检查排版（不改变排版本身） */
  debug?: boolean;
  /**
   * true = 用户声明「内容顺序可打乱」（RULES.md S2 的用户声明入口）：
   * 开启跨页回填——后面的块可以填进前面页的缺口，牺牲跨页阅读顺序换密度。
   * 默认 false（力学层保守假定顺序刚性强）。
   */
  allowReorder?: boolean;
  /**
   * 用户声明的学科 id（SUBJECT_RULES 的键，如 'calculus' / 'politics'）——学科层补充
   * 特征的来源：顺序刚性（politics 弱 → 自动开回填）、原子角色（os 表核心 → H3 生效）。
   * 响应里的 subjectSuggestion 只是关键词识别建议，用户选了才算声明。
   */
  subject?: string;
}

function validate(body: SceneRequest): string | null {
  if (typeof body.markdown !== 'string' || body.markdown.trim() === '') {
    return 'markdown 不能为空';
  }
  if (body.targetPages !== undefined) {
    const n = Number(body.targetPages);
    if (!Number.isInteger(n) || n < 1 || n > 50) return 'targetPages 必须是 1~50 的整数';
  }
  if (body.scene !== undefined && body.scene !== 'auto' && !SCENE_PRESETS[body.scene]) {
    return `scene 必须是 auto / ${Object.keys(SCENE_PRESETS).join(' / ')}`;
  }
  if (
    body.orientation !== undefined &&
    body.orientation !== 'portrait' &&
    body.orientation !== 'landscape'
  ) {
    return 'orientation 必须是 portrait 或 landscape';
  }
  if (body.subject !== undefined && body.subject !== '' && !SUBJECT_RULES[body.subject]) {
    return `subject 必须是 ${Object.keys(SUBJECT_RULES).join(' / ')} 之一（或省略）`;
  }
  return null;
}

sceneRouter.post('/scene', async (req: Request, res: Response) => {
  const body = req.body as SceneRequest;
  const invalid = validate(body);
  if (invalid) {
    res.status(400).json({ error: invalid } satisfies ApiErrorResponse);
    return;
  }

  const targetPages = body.targetPages ?? 1;
  const orientation = body.orientation ?? 'portrait';

  try {
    const blocks = chunkMarkdown(body.markdown);
    const stats = analyzeContent(blocks);
    const subject = body.subject ? SUBJECT_RULES[body.subject] : undefined;
    const derived = deriveLayoutParams(stats, {
      allowReorder: body.allowReorder === true,
      subject,
    });

    // 自动模式用规则引擎的交集参数（多类刚性原子同时保护）；
    // 用户强制指定预设则以预设为准（预设 = 命名快捷方式，用户的选择就是覆盖）
    const auto = !body.scene || body.scene === 'auto';
    const usedScene: SceneId = auto ? derived.sceneEquivalent : (body.scene as SceneId);
    const preset = SCENE_PRESETS[usedScene];
    const params = auto
      ? derived.params
      : {
          density: preset.density,
          strategy: preset.strategy,
          minScale: preset.minScale,
          maxAspect: preset.maxAspect,
          gutterMm: preset.gutterMm,
          widthTiers: preset.widthTiers ? [...preset.widthTiers] : undefined,
          backfill: body.allowReorder === true,
        };

    const formulaIssues = await precheckFormulas(blocks);

    const outcome = await searchGridFontSize({
      markdown: body.markdown,
      targetPages,
      paperSize: 'A4',
      orientation,
      margins: DEFAULT_MARGINS,
      density: params.density,
      strategy: params.strategy,
      minScale: params.minScale,
      maxAspect: params.maxAspect,
      gutterMm: params.gutterMm,
      widthTiers: params.widthTiers ? [...params.widthTiers] : undefined,
      backfill: params.backfill,
    });
    const { best } = outcome;

    const { pdfBuffer, pageCount } = await renderGridPdf(
      outcome.blocks,
      best.placements,
      outcome.grid,
      {
        paperSize: 'A4',
        orientation,
        margins: DEFAULT_MARGINS,
        fontSize: best.fontSize,
        density: params.density,
        debug: body.debug === true,
      }
    );

    const jobId = randomUUID();
    // 调试版单独命名，免得和正式版下载到同一个文件名互相覆盖
    const baseName = derivePdfName(body.markdown);
    const fileName = body.debug ? baseName.replace(/\.pdf$/, '-网格.pdf') : baseName;
    saveJob(jobId, pdfBuffer, fileName);

    res.json({
      fileName,
      stats,
      recommended: {
        scene: derived.sceneEquivalent,
        name: SCENE_PRESETS[derived.sceneEquivalent].name,
        reason: derived.reason,
        // 多类刚性原子并存的提示（保护已同时生效，但空间更紧）
        warning: derived.warning,
      },
      // rule trace：实际触发的规则记账（RULES.md §三），自动模式的参数由它决定；
      // 用户强制预设时 trace 仍返回（说明引擎本来会怎么排），但生效的是预设参数
      trace: derived.trace,
      // 学科声明与识别建议（建议 ≠ 声明：前端提示"检测到可能是 X 课"，用户选了才生效）
      subject: subject?.id ?? null,
      subjectSuggestion: suggestSubject(body.markdown),
      usedScene,
      usedSceneName: preset.name,
      fontSize: best.fontSize,
      pages: pageCount,
      // 用实测 PDF 页数判定，而不是搜索阶段的拼装估算——两者不一致时（如渲染尾部
      // 多出一页）估算口径会出现"达标 ✓ 但 pages > targetPages"的自相矛盾响应
      withinTargetPages: pageCount <= targetPages,
      history: outcome.history,
      warnings: {
        oversized: best.oversized,
        cramped: best.cramped,
        formulaIssues,
      },
      jobId,
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: `场景排版失败: ${String(err)}` } satisfies ApiErrorResponse);
  }
});
