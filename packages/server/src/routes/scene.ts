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
import { renderGridPdf, resolveGrid, searchGridFontSize } from '../engine/grid-layout.js';
import { PX_PER_MM } from '../engine/measure-blocks.js';
import { searchAdjudicated } from '../engine/adjudicate.js';
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
  /**
   * 四边统一页边距 mm（3~25），省略 = 默认 10。降到 6mm 白捡约 7.6% 版面
   * （多数打印机 5mm 内安全）；低于 3mm 基本必被打印机裁掉，不放行。
   */
  marginMm?: number;
  /**
   * 满版伸展（默认开）：搜索定稿后逐块微放大字号（≤+2pt），把柱底/块间的
   * 空隙换成更大的字。false = 关（全文严格等字号的老行为）。
   */
  stretchFill?: boolean;
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
  if (body.marginMm !== undefined) {
    const m = Number(body.marginMm);
    if (!Number.isFinite(m) || m < 3 || m > 25) return 'marginMm 必须是 3~25 的数字（毫米）';
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
  const margins =
    body.marginMm !== undefined
      ? { top: body.marginMm, bottom: body.marginMm, left: body.marginMm, right: body.marginMm }
      : DEFAULT_MARGINS;
  const startedAt = Date.now();

  try {
    const blocks = chunkMarkdown(body.markdown);
    const stats = analyzeContent(blocks);
    const subject = body.subject ? SUBJECT_RULES[body.subject] : undefined;
    const staticDerived = deriveLayoutParams(stats, {
      allowReorder: body.allowReorder === true,
      subject,
    });

    const auto = !body.scene || body.scene === 'auto';
    const formulaIssues = await precheckFormulas(blocks);

    const baseSearch = {
      markdown: body.markdown,
      targetPages,
      paperSize: 'A4' as const,
      orientation,
      margins,
      stretchFill: body.stretchFill !== false,
    };

    // 自动模式用规则引擎的交集参数（多类刚性原子同时保护），模糊带内双跑实测裁决（B1）；
    // 用户强制指定预设则以预设为准（预设 = 命名快捷方式，用户的选择就是覆盖，不裁决）
    let derived = staticDerived;
    let outcome;
    if (auto) {
      const adjudicated = await searchAdjudicated(baseSearch, staticDerived);
      derived = adjudicated.derived;
      outcome = adjudicated.outcome;
    } else {
      const preset = SCENE_PRESETS[body.scene as SceneId];
      outcome = await searchGridFontSize({
        ...baseSearch,
        density: preset.density,
        strategy: preset.strategy,
        minScale: preset.minScale,
        maxAspect: preset.maxAspect,
        gutterMm: preset.gutterMm,
        widthTiers: preset.widthTiers ? [...preset.widthTiers] : undefined,
        backfill: body.allowReorder === true,
      });
    }
    const usedScene: SceneId = auto ? derived.sceneEquivalent : (body.scene as SceneId);
    const preset = SCENE_PRESETS[usedScene];
    const renderDensity = auto ? derived.params.density : preset.density;
    const { best } = outcome;

    const { pdfBuffer, pageCount } = await renderGridPdf(
      outcome.blocks,
      best.placements,
      outcome.grid,
      {
        paperSize: 'A4',
        orientation,
        margins,
        fontSize: best.fontSize,
        density: renderDensity,
        debug: body.debug === true,
        stretched: best.stretched,
      }
    );

    // —— 网页测试台诊断：每块的档位/落页/缩放 + 每页填充率 ——
    // 填充率按拼装几何估算（盒面积/内容区面积）；oversized 块可能把单页推过 100%，
    // 这本身是有用的信号，不截断。落页用拼装页码（0-based → 展示转 1-based）。
    const { grid } = outcome;
    const { contentHMm } = resolveGrid({ paperSize: 'A4', orientation, margins });
    const measById = new Map(best.measurements.map((m) => [m.id, m]));
    const placeById = new Map(best.placements.map((p) => [p.id, p]));
    const stretchedMap = best.stretched ?? {};
    const boxHeightMm = (id: string): number | null => {
      // 满版伸展过的块按放大后的实际高度算，填充率才如实
      const heightPx = stretchedMap[id]?.heightPx ?? measById.get(id)?.heightPx;
      return heightPx !== undefined ? heightPx / PX_PER_MM + grid.gutterMm : null;
    };
    const pageAreas = new Map<number, number>();
    for (const p of best.placements) {
      const h = boxHeightMm(p.id);
      if (h === null) continue;
      pageAreas.set(p.page, (pageAreas.get(p.page) ?? 0) + p.span * grid.unitMm * h);
    }
    const pageAreaMm2 = grid.unitsX * grid.unitMm * contentHMm;
    const fillPages = Math.max(best.pages, 1);
    const diagnostics = {
      grid: {
        unitsX: grid.unitsX,
        unitMm: Math.round(grid.unitMm * 100) / 100,
        gutterMm: Math.round(grid.gutterMm * 100) / 100,
        widthTiers: grid.widthTiers,
      },
      blocks: outcome.blocks.map((b) => {
        const m = measById.get(b.id);
        const p = placeById.get(b.id);
        const h = boxHeightMm(b.id);
        return {
          id: b.id,
          title: b.title || (b.kind === 'image' ? '（图片）' : '（前言）'),
          kind: b.kind,
          span: m?.span ?? 0,
          page: p ? p.page + 1 : null,
          heightMm: h === null ? null : Math.round(h * 10) / 10,
          scale: m ? Math.round(m.scale * 100) / 100 : 1,
          formulaScale: m ? Math.round(m.formulaScale * 100) / 100 : 1,
          belowMinScale: m?.belowMinScale ?? false,
          oversized: best.oversized.includes(b.id),
          // 满版伸展后的块级字号（null = 未放大，仍是全局字号）
          stretchedPt: stretchedMap[b.id]?.fontSize ?? null,
        };
      }),
      pageFill: Array.from({ length: fillPages }, (_, i) =>
        Math.round(((pageAreas.get(i) ?? 0) / pageAreaMm2) * 100)
      ),
      overallFill: Math.round(
        ([...pageAreas.values()].reduce((a, b) => a + b, 0) / (pageAreaMm2 * fillPages)) * 100
      ),
      elapsedMs: Date.now() - startedAt,
    };

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
      diagnostics,
      jobId,
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: `场景排版失败: ${String(err)}` } satisfies ApiErrorResponse);
  }
});
