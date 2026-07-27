/**
 * Studio 的两大主动作：转换（⓪ AI 结构化,SSE 逐 source 排队）与生成 PDF（/api/scene）。
 * 动作条、source 编辑视图、右栏招牌卡共用；每个动作在对话流里一来一回（用户消息 + 系统卡）。
 *
 * 统一输入闸(spec: docs/superpowers/specs/2026-07-28-unified-input-gate-design.md):
 * 任何文本材料必须经 /api/ai/structurize 的指定提示词转成标准 Markdown 才能排版。
 * generate 是唯一漏斗——先自动转换所有 enabled 生料,任一失败即中止,绝不 raw 兜底;
 * 没配 AI 就明确报错引导去「AI 设置」。图片/联网检索产物豁免(落地即标准 Markdown)。
 */
import { apiFetch } from '../../api';
import { consumeSse } from '../../lib/sse';
import type { SceneResult } from '../../types';
import { byokProvider } from './aiConfig';
import {
  combineForChat,
  combineForLayout,
  newId,
  useStudio,
  type PdfCardData,
  type Source,
  type StructurizeCheck,
} from './useStudioStore';

/** 结果里的各类警告压成人话行（与旧界面同一套口径） */
function warnLines(r: SceneResult, targetPages: number): string[] {
  return [
    ...(r.recommended.warning ? [r.recommended.warning] : []),
    ...r.warnings.formulaIssues.map(
      (i) => `公式错误 @「${i.blockTitle || i.blockId}」: ${i.message}`
    ),
    ...(r.warnings.oversized.length
      ? [`超高块（会被截断）: ${r.warnings.oversized.join(', ')}`]
      : []),
    ...(r.warnings.cramped.length
      ? [`宽内容缩到可读下限以下: ${r.warnings.cramped.join(', ')}`]
      : []),
    ...(!r.withinTargetPages
      ? [`目标 ${targetPages} 页塞不下，当前是尽力结果：加页数或精简材料再试`]
      : []),
  ];
}

/** 进行中请求的中断句柄。同一时刻至多一个对话/一条转换队列(state 里的
 *  chatting/converting 防重入),模块级单例即可,不必进 store。 */
let chatAbort: AbortController | null = null;
let convertAbort: AbortController | null = null;
/** 「停止」要停的是整条转换队列,不只是当前份 */
let convertQueueStopped = false;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

/** 转换结果:失败时区分「用户停止」与「AI 未配置(501)」——队列要据此决定停不停 */
type ConvertOutcome =
  | { ok: true; markdown: string }
  | { ok: false; aborted: boolean; configError: boolean };

export function useStudioActions() {
  const { state, dispatch } = useStudio();

  /** 统一输入闸的内核:把任意文本经指定提示词转成标准 Markdown。
   *  自带完整叙事(用户消息 + convert 卡 + SSE 流式 + 体检结论),**不写任何 source**——
   *  写回语义由调用方决定。opts.sourceId 只在转换真实材料时传(卡片重试按钮据此定位;
   *  写回对话产物时不传,重试走回复卡上的「写回」)。 */
  const convertText = async (
    text: string,
    cardTitle: string,
    opts: { sourceId?: string; announce?: string } = {}
  ): Promise<ConvertOutcome> => {
    if (opts.sourceId) dispatch({ type: 'set_converting_source', id: opts.sourceId });
    dispatch({
      type: 'add_message',
      message: {
        id: newId(),
        role: 'user',
        kind: 'text',
        text: opts.announce ?? `转换《${cardTitle}》`,
      },
    });
    const cardId = newId();
    dispatch({
      type: 'add_message',
      message: {
        id: cardId,
        role: 'system',
        kind: 'convert',
        phase: 'working',
        sourceId: opts.sourceId,
        sourceTitle: cardTitle,
        preview: '',
        attempt: 1,
      },
    });
    convertAbort = new AbortController();
    let configError = false;
    try {
      const resp = await apiFetch('/api/ai/structurize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, provider: byokProvider() ?? undefined }),
        signal: convertAbort.signal,
      });
      if (!resp.ok || !resp.headers.get('content-type')?.includes('event-stream')) {
        configError = resp.status === 501; // 服务器没配统一 key 且用户没填 BYOK
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      // attempt 变化 = 首轮体检不过、AI 在重写——缓冲清空重新累积（SSE 契约见 API.md）
      let attempt = 1;
      let acc = '';
      let resultMd: string | null = null;
      let streamError: string | null = null;
      await consumeSse(resp, (event, data) => {
        if (event === 'delta') {
          const a = Number(data.attempt) || 1;
          if (a !== attempt) {
            attempt = a;
            acc = '';
          }
          acc += String(data.text ?? '');
          dispatch({ type: 'update_message', id: cardId, patch: { preview: acc, attempt } });
        } else if (event === 'retry') {
          const problems = (data.problems as string[]) ?? [];
          dispatch({
            type: 'update_message',
            id: cardId,
            patch: { text: `结构体检未过，AI 修正中（${problems.join('、')}）` },
          });
        } else if (event === 'result') {
          const md = String(data.markdown ?? '');
          resultMd = md;
          const check = (data.check as unknown as StructurizeCheck) ?? null;
          dispatch({
            type: 'update_message',
            id: cardId,
            patch: { phase: 'done', preview: md, check, text: undefined },
          });
        } else if (event === 'error') {
          streamError = String(data.error ?? '未知错误');
        }
      });
      if (streamError) throw new Error(streamError);
      if (resultMd === null) throw new Error('转换中断，未收到最终结果，请重试');
      return { ok: true, markdown: resultMd };
    } catch (e) {
      // 手动停止:半截产物不外流(排版吃了残缺 Markdown 比没有更糟),记错误卡
      const aborted = isAbortError(e);
      dispatch({
        type: 'update_message',
        id: cardId,
        patch: {
          phase: 'error',
          error: aborted ? '已手动停止' : e instanceof Error ? e.message : String(e),
          configError,
        },
      });
      return { ok: false, aborted, configError };
    } finally {
      convertAbort = null;
      if (opts.sourceId) dispatch({ type: 'set_converting_source', id: null });
    }
  };

  /** 材料过闸：转换 source.raw,成品写回 markdown 并标 converted。失败上卡不抛。 */
  const convertOne = async (source: Source): Promise<ConvertOutcome> => {
    const out = await convertText(source.raw, source.title, { sourceId: source.id });
    if (out.ok) {
      dispatch({
        type: 'update_source',
        id: source.id,
        patch: { markdown: out.markdown, status: 'converted' },
      });
    }
    return out;
  };

  /** 「转换生料」= 对所有 enabled 且 status=raw 的 source 按序逐个转换（spec 已拍） */
  const convertAllRaw = async (): Promise<void> => {
    const raws = state.sources.filter((s) => s.enabled && s.status === 'raw' && s.raw.trim());
    if (raws.length === 0 || state.converting) return;
    dispatch({ type: 'set_converting', value: true });
    convertQueueStopped = false;
    try {
      for (const s of raws) {
        if (convertQueueStopped) break;
        await convertOne(s);
      }
    } finally {
      dispatch({ type: 'set_converting', value: false });
    }
  };

  /** 停止转换:中断当前份并放弃队列后续 */
  const stopConvert = (): void => {
    convertQueueStopped = true;
    convertAbort?.abort();
  };

  /** 编辑视图「转换这份」：单个走队列同一条路 */
  const convertSingle = async (source: Source): Promise<void> => {
    if (state.converting || !source.raw.trim()) return;
    dispatch({ type: 'set_converting', value: true });
    convertQueueStopped = false;
    try {
      await convertOne(source);
    } finally {
      dispatch({ type: 'set_converting', value: false });
    }
  };

  /** 对话回复写回已有材料:回复文本先过闸(structurize),成品覆盖 markdown。
   *  target.raw 永远不动——「从原文重新转换」的后悔药保持有效。 */
  const writeBackChat = async (target: Source, replyText: string): Promise<void> => {
    if (state.converting || !replyText.trim()) return;
    dispatch({ type: 'set_converting', value: true });
    convertQueueStopped = false;
    try {
      const out = await convertText(replyText, target.title, {
        announce: `写回《${target.title}》`,
      });
      if (out.ok) {
        dispatch({
          type: 'update_source',
          id: target.id,
          patch: { markdown: out.markdown, status: 'converted' },
        });
      }
    } finally {
      dispatch({ type: 'set_converting', value: false });
    }
  };

  /** 私有:纯排版。进到这里的 enabled 材料必须全部 converted——
   *  combineForLayout 只吃 converted,是最后一道硬保险。 */
  const generateCore = async (sources: Source[]): Promise<void> => {
    const combined = combineForLayout(sources);
    if (!combined.trim() || state.generating) return;
    const cfg = state.genConfig;
    const enabledCount = sources.filter(
      (s) => s.enabled && s.status === 'converted' && s.markdown.trim()
    ).length;
    dispatch({
      type: 'add_message',
      message: {
        id: newId(),
        role: 'user',
        kind: 'text',
        text: `生成 PDF（${enabledCount} 份材料 · 目标 ${cfg.targetPages} 页）`,
      },
    });
    const cardId = newId();
    dispatch({
      type: 'add_message',
      message: { id: cardId, role: 'system', kind: 'pdf', phase: 'working' },
    });
    dispatch({ type: 'set_generating', value: true });
    try {
      const resp = await apiFetch('/api/scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: combined,
          targetPages: cfg.targetPages,
          scene: cfg.scene,
          orientation: cfg.orientation,
          debug: cfg.debug,
          allowReorder: cfg.allowReorder,
          subject: cfg.subject || undefined,
          marginMm: cfg.marginMm,
          stretchFill: cfg.stretchFill,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      const r = data as SceneResult;
      const pdfResp = await apiFetch(`/api/download/${r.jobId}/pdf`);
      if (!pdfResp.ok) throw new Error('PDF 下载失败');
      const blob = await pdfResp.blob();
      const pdf: PdfCardData = {
        fileName: r.fileName,
        fontSize: r.fontSize,
        pages: r.pages,
        targetPages: cfg.targetPages,
        withinTarget: r.withinTargetPages,
        fill: r.diagnostics?.overallFill ?? null,
        warnings: warnLines(r, cfg.targetPages),
        pdfUrl: URL.createObjectURL(blob),
      };
      dispatch({ type: 'update_message', id: cardId, patch: { phase: 'done', pdf } });
      dispatch({
        type: 'record_run',
        result: r,
        run: {
          config: [
            cfg.scene === 'auto' ? '自动' : cfg.scene,
            cfg.subject || null,
            `目标${cfg.targetPages}页`,
            cfg.orientation === 'landscape' ? '横' : '竖',
            cfg.allowReorder ? '乱序' : null,
            cfg.marginMm !== 10 ? `边距${cfg.marginMm}mm` : null,
            !cfg.stretchFill ? '不伸展' : null,
            `${enabledCount}份材料`,
          ]
            .filter(Boolean)
            .join(' · '),
          fontSize: r.fontSize,
          pages: r.pages,
          ok: r.withinTargetPages,
          fill: r.diagnostics?.overallFill ?? null,
          secs: r.diagnostics ? (r.diagnostics.elapsedMs / 1000).toFixed(1) : null,
        },
      });
    } catch (e) {
      dispatch({
        type: 'update_message',
        id: cardId,
        patch: { phase: 'error', error: e instanceof Error ? e.message : String(e) },
      });
    } finally {
      dispatch({ type: 'set_generating', value: false });
    }
  };

  /** 任何入口的「生成 PDF」:统一输入闸的漏斗口。
   *  先自动转换所有 enabled 生料,任一失败即中止并点名——绝不 raw 兜底;
   *  转换产物同步进本地副本再排(闭包里的 state.sources 是点击时的快照,陈旧闭包坑)。 */
  const generate = async (): Promise<void> => {
    if (state.converting || state.generating) return;
    const updated = state.sources.map((s) => ({ ...s }));
    const raws = updated.filter((s) => s.enabled && s.status === 'raw' && s.raw.trim());
    if (raws.length > 0) {
      dispatch({ type: 'set_converting', value: true });
      convertQueueStopped = false;
      const failed: string[] = [];
      let configError = false;
      try {
        for (const s of raws) {
          if (convertQueueStopped) break;
          const out = await convertOne(s);
          if (out.ok) {
            s.markdown = out.markdown;
            s.status = 'converted';
          } else if (out.aborted) {
            break;
          } else {
            failed.push(s.title);
            // 没配 AI 时每份都会报同一个错,没必要刷 N 张错误卡
            if (out.configError) {
              configError = true;
              break;
            }
          }
        }
      } finally {
        dispatch({ type: 'set_converting', value: false });
      }
      if (convertQueueStopped) {
        dispatch({
          type: 'add_message',
          message: {
            id: newId(),
            role: 'system',
            kind: 'text',
            text: '已手动停止，本次排版取消；已转换的份保留。',
          },
        });
        return;
      }
      if (failed.length > 0) {
        dispatch({
          type: 'add_message',
          message: {
            id: newId(),
            role: 'system',
            kind: 'text',
            error: configError
              ? `未配置 AI，无法转换材料——排版已中止。到「AI 设置」填一个 key 再试。`
              : `转换失败，已中止排版：${failed.map((t) => `《${t}》`).join('、')}。修好或取消勾选后再生成。`,
            configError,
          },
        });
        return;
      }
    }
    await generateCore(updated);
  };

  /** 自由对话（/api/ai/chat SSE）：材料 = 圈定(缺省全部) enabled sources 拼接;
   *  历史 = 之前完成的 chat 轮。scopeIds 随消息存档,供「写回」定位与重试原样重发 */
  const sendChat = async (text: string, scopeIds?: string[]): Promise<void> => {
    const content = text.trim();
    if (!content || state.chatting) return;
    const scope = scopeIds?.length
      ? state.sources.filter((s) => scopeIds.includes(s.id))
      : state.sources;
    // 只有 kind:'chat' 进对话历史——转换/生成的动作卡与 AI 无对话语义
    const history = state.messages
      .filter((m) => m.kind === 'chat' && (m.role === 'user' || (m.role === 'assistant' && m.phase === 'done')))
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text ?? '' }))
      .filter((m) => m.content.trim());
    dispatch({
      type: 'add_message',
      message: { id: newId(), role: 'user', kind: 'chat', text: content, scopeIds },
    });
    const cardId = newId();
    dispatch({
      type: 'add_message',
      message: {
        id: cardId,
        role: 'assistant',
        kind: 'chat',
        phase: 'working',
        preview: '',
        prompt: content,
        scopeIds,
      },
    });
    dispatch({ type: 'set_chatting', value: true });
    chatAbort = new AbortController();
    let acc = '';
    try {
      const resp = await apiFetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...history, { role: 'user', content }],
          context: combineForChat(scope),
          provider: byokProvider() ?? undefined,
        }),
        signal: chatAbort.signal,
      });
      if (!resp.ok || !resp.headers.get('content-type')?.includes('event-stream')) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      let reply: string | null = null;
      let streamError: string | null = null;
      await consumeSse(resp, (event, data) => {
        if (event === 'delta') {
          acc += String(data.text ?? '');
          dispatch({ type: 'update_message', id: cardId, patch: { preview: acc } });
        } else if (event === 'result') {
          reply = String(data.reply ?? '');
          dispatch({
            type: 'update_message',
            id: cardId,
            patch: { phase: 'done', text: reply, preview: undefined },
          });
        } else if (event === 'error') {
          streamError = String(data.error ?? '未知错误');
        }
      });
      if (streamError) throw new Error(streamError);
      if (reply === null) throw new Error('对话中断，未收到完整回复，请重试');
    } catch (e) {
      if (isAbortError(e) && acc.trim()) {
        // 手动停止但已有流出内容:保留为完成态,后续「存为新材料/写回」照常可用
        dispatch({
          type: 'update_message',
          id: cardId,
          patch: { phase: 'done', text: acc, preview: undefined, stopped: true },
        });
      } else {
        dispatch({
          type: 'update_message',
          id: cardId,
          patch: {
            phase: 'error',
            error: isAbortError(e) ? '已手动停止' : e instanceof Error ? e.message : String(e),
          },
        });
      }
    } finally {
      chatAbort = null;
      dispatch({ type: 'set_chatting', value: false });
    }
  };

  /** 停止当前对话轮:已流出的部分保留 */
  const stopChat = (): void => {
    chatAbort?.abort();
  };

  return {
    convertAllRaw,
    convertSingle,
    writeBackChat,
    generate,
    sendChat,
    stopChat,
    stopConvert,
  };
}
