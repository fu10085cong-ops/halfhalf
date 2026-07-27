/**
 * Studio 的两大主动作：转换生料（⓪ AI 结构化,SSE 逐 source 排队）与生成 PDF（/api/scene）。
 * 动作条、source 编辑视图、右栏生成卡共用；每个动作在对话流里一来一回（用户消息 + 系统卡）。
 */
import { apiFetch } from '../../api';
import { consumeSse } from '../../lib/sse';
import type { SceneResult } from '../../types';
import { byokProvider } from './aiConfig';
import {
  combineEnabledMarkdown,
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

export function useStudioActions() {
  const { state, dispatch } = useStudio();

  /** 转换单个 source：SSE 流式进对话卡，成品写回 source 并返回产物 Markdown。
   *  失败上卡不抛、返回 null（队列不断;一键流程对失败份用 raw 兜底继续排） */
  const convertOne = async (source: Source): Promise<string | null> => {
    dispatch({ type: 'set_converting_source', id: source.id });
    dispatch({
      type: 'add_message',
      message: { id: newId(), role: 'user', kind: 'text', text: `转换《${source.title}》` },
    });
    const cardId = newId();
    dispatch({
      type: 'add_message',
      message: {
        id: cardId,
        role: 'system',
        kind: 'convert',
        phase: 'working',
        sourceId: source.id,
        sourceTitle: source.title,
        preview: '',
        attempt: 1,
      },
    });
    convertAbort = new AbortController();
    try {
      const resp = await apiFetch('/api/ai/structurize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: source.raw, provider: byokProvider() ?? undefined }),
        signal: convertAbort.signal,
      });
      if (!resp.ok || !resp.headers.get('content-type')?.includes('event-stream')) {
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
            type: 'update_source',
            id: source.id,
            patch: { markdown: md, status: 'converted' },
          });
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
      return resultMd;
    } catch (e) {
      // 手动停止:半截产物不写回(排版吃了残缺 Markdown 比没有更糟),记错误卡
      dispatch({
        type: 'update_message',
        id: cardId,
        patch: {
          phase: 'error',
          error: isAbortError(e) ? '已手动停止' : e instanceof Error ? e.message : String(e),
        },
      });
      return null;
    } finally {
      convertAbort = null;
      dispatch({ type: 'set_converting_source', id: null });
    }
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
    try {
      await convertOne(source);
    } finally {
      dispatch({ type: 'set_converting', value: false });
    }
  };

  /** 逃生门：不经 AI，生料原样当成品（没配 key/AI 挂了时的直通路径） */
  const skipAi = (source: Source): void => {
    dispatch({
      type: 'update_source',
      id: source.id,
      patch: { markdown: source.raw, status: 'converted' },
    });
  };

  /** 生成 PDF：enabled sources 按序拼接 → /api/scene → 结果卡 + 历史/诊断入账。
   *  sourcesOverride:一键流程刚转换完的最新副本——闭包里的 state.sources 是点击时的
   *  快照,组合动作里直接用会把已转换的份又当生料排(陈旧闭包坑) */
  const generate = async (sourcesOverride?: Source[]): Promise<void> => {
    const sources = sourcesOverride ?? state.sources;
    const combined = combineEnabledMarkdown(sources);
    if (!combined.trim() || state.generating) return;
    const cfg = state.genConfig;
    const enabledCount = sources.filter((s) => s.enabled && (s.markdown || s.raw).trim()).length;
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
          context: combineEnabledMarkdown(scope),
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

  /** 招牌动作「一键转换并排版」:生料全转（失败份用 raw 兜底）→ 立刻生成 PDF。
   *  转换产物同步进本地副本再交给 generate——不能依赖闭包里的旧 state（陈旧闭包坑） */
  const convertAndGenerate = async (): Promise<void> => {
    if (state.converting || state.generating) return;
    const updated = state.sources.map((s) => ({ ...s }));
    const raws = updated.filter((s) => s.enabled && s.status === 'raw' && s.raw.trim());
    if (raws.length > 0) {
      dispatch({ type: 'set_converting', value: true });
      convertQueueStopped = false;
      try {
        for (const s of raws) {
          if (convertQueueStopped) break;
          const md = await convertOne(s);
          if (md !== null) {
            s.markdown = md;
            s.status = 'converted';
          }
        }
      } finally {
        dispatch({ type: 'set_converting', value: false });
      }
      // 用户按了停止 = 放弃这次一键流程,不拿半套材料去排版
      if (convertQueueStopped) return;
    }
    await generate(updated);
  };

  return {
    convertAllRaw,
    convertSingle,
    skipAi,
    generate,
    convertAndGenerate,
    sendChat,
    stopChat,
    stopConvert,
  };
}
