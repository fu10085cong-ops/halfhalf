/**
 * Studio 三栏前端的全局状态（spec: docs/superpowers/specs/2026-07-27-studio-ui-design.md）。
 * context + reducer；只有 sources 持久化到 localStorage（刷新不丢），
 * 对话流/结果/视图都是会话态。超限（配额/隐私模式）降级为会话内存并亮提示。
 */
import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import type { SceneId, SceneResult } from '../../types';
import type { KnowledgeDocument } from '../../types/restructure';

// ---------- 数据模型 ----------

export interface Source {
  id: string;
  title: string;
  kind: 'paste' | 'file' | 'url';
  /** 原始生料（粘贴原文/文档提取物） */
  raw: string;
  /** 标准 Markdown（统一经 AI 转换的产物）；未转换为空串 */
  markdown: string;
  status: 'raw' | 'converted';
  /** 是否参与排版（拼接口径：enabled 的按序拼接） */
  enabled: boolean;
  /**
   * 导入产物的可追溯知识节点（目前只有 PDF 有）。重点规划面板拿它出计划。
   * 刻意只活在本次会话：一份十几页 PDF 有几百个节点，塞进 localStorage 会把
   * 本就吃紧的配额顶爆（raw 里还压着 base64 页面图）。刷新后从「最近导入」重新打开即可。
   */
  knowledge?: KnowledgeDocument;
  meta: { charCount: number; importSummary?: string; createdAt: number };
}

export interface StructurizeCheck {
  ok: boolean;
  problems: string[];
  blockCount: number;
  /**
   * true = 检出疑似新增知识(保真红线),而非单纯结构瑕疵。
   * 界面必须区别对待:结构差只是版面欠佳,内容被添加会被用户当成自己的笔记打印进考场。
   * 服务端定义见 packages/server/src/engine/ai-structurize.ts。
   */
  fabricationSuspected?: boolean;
}

/** PDF 结果卡的展示数据（blob URL 只活在会话内，不持久化） */
export interface PdfCardData {
  fileName: string;
  fontSize: number;
  pages: number;
  targetPages: number;
  withinTarget: boolean;
  fill: number | null;
  warnings: string[];
  pdfUrl: string;
}

/** 操作流对话的一张卡；convert/pdf/chat 卡随请求推进原地更新（phase）。
 *  kind 'chat' = 自由对话轮（/api/ai/chat）——只有它进对话历史，动作卡不算。
 *  kind 'guide' = 新生料落卡后的自动引导（转换是产品特色也是必经环节:检测到生料→一键转换） */
export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'convert' | 'pdf' | 'chat' | 'guide';
  text?: string;
  phase?: 'working' | 'done' | 'error';
  /** convert 卡：目标 source 与流式缓冲；chat 卡也用 preview 做流式缓冲 */
  sourceId?: string;
  sourceTitle?: string;
  preview?: string;
  attempt?: number;
  check?: StructurizeCheck | null;
  pdf?: PdfCardData | null;
  error?: string;
  /** chat 卡:该轮圈定的材料(undefined = 全部);assistant 卡上供「写回」定位 */
  scopeIds?: string[];
  /** chat assistant 卡:发起该轮的用户原话,供错误卡「重试」原样重发 */
  prompt?: string;
  /** 手动停止:done 但内容是截到停止时刻的部分回复 */
  stopped?: boolean;
  /** 错误源于 AI 未配置(501)——错误卡上渲染「去 AI 设置」按钮 */
  configError?: boolean;
}

/** 生成参数（右栏生成卡持有，中栏动作条读取） */
export interface GenConfig {
  targetPages: number;
  scene: SceneId | 'auto';
  subject: string;
  orientation: 'portrait' | 'landscape';
  marginMm: number;
  debug: boolean;
  allowReorder: boolean;
  stretchFill: boolean;
  /**
   * 严格保持原文顺序。null = 跟随 AI 判断（structurize 写在材料首行的
   * source-order 标记），true/false = 用户显式覆盖。
   */
  strictSourceOrder: boolean | null;
}

/** 会话生成历史一行（历史面板；改一个参数再生成即可对照） */
export interface RunRecord {
  config: string;
  fontSize: number;
  pages: number;
  ok: boolean;
  fill: number | null;
  secs: string | null;
}

/** 居中弹窗（Organic 弹窗语言）：同一时刻只开一个 */
export type StudioModal =
  | 'compress'
  | 'diagnostics'
  | 'history'
  | 'settings'
  | 'focus'
  | 'research'
  | null;

export interface StudioState {
  sources: Source[];
  messages: StudioMessage[];
  genConfig: GenConfig;
  /** 当前打开的居中弹窗（null = 无） */
  modal: StudioModal;
  /** 非 null = 中栏切换为该 source 的编辑视图 */
  editingSourceId: string | null;
  pdfOverlay: { url: string; fileName: string } | null;
  /** 队列转换/生成/对话进行中（动作条防重入） */
  converting: boolean;
  /** 正在转换的 source（招牌卡逐份进度用；非转换期为 null） */
  convertingSourceId: string | null;
  generating: boolean;
  chatting: boolean;
  lastResult: SceneResult | null;
  runs: RunRecord[];
}

// ---------- reducer ----------

export type StudioAction =
  | { type: 'add_source'; source: Source }
  | { type: 'update_source'; id: string; patch: Partial<Source> }
  | { type: 'remove_source'; id: string }
  | { type: 'toggle_source'; id: string }
  | { type: 'add_message'; message: StudioMessage }
  | { type: 'update_message'; id: string; patch: Partial<StudioMessage> }
  | { type: 'set_config'; patch: Partial<GenConfig> }
  | { type: 'set_modal'; modal: StudioModal }
  | { type: 'edit_source'; id: string | null }
  | { type: 'set_overlay'; overlay: { url: string; fileName: string } | null }
  | { type: 'set_converting'; value: boolean }
  | { type: 'set_converting_source'; id: string | null }
  | { type: 'set_generating'; value: boolean }
  | { type: 'set_chatting'; value: boolean }
  | { type: 'record_run'; run: RunRecord; result: SceneResult };

function reducer(state: StudioState, action: StudioAction): StudioState {
  switch (action.type) {
    case 'add_source':
      return { ...state, sources: [...state.sources, action.source] };
    case 'update_source':
      return {
        ...state,
        sources: state.sources.map((s) => (s.id === action.id ? { ...s, ...action.patch } : s)),
      };
    case 'remove_source':
      return {
        ...state,
        sources: state.sources.filter((s) => s.id !== action.id),
        editingSourceId: state.editingSourceId === action.id ? null : state.editingSourceId,
      };
    case 'toggle_source':
      return {
        ...state,
        sources: state.sources.map((s) =>
          s.id === action.id ? { ...s, enabled: !s.enabled } : s
        ),
      };
    case 'add_message':
      return { ...state, messages: [...state.messages, action.message] };
    case 'update_message':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m)),
      };
    case 'set_config':
      return { ...state, genConfig: { ...state.genConfig, ...action.patch } };
    case 'set_modal':
      return { ...state, modal: action.modal };
    case 'edit_source':
      return { ...state, editingSourceId: action.id };
    case 'set_overlay':
      return { ...state, pdfOverlay: action.overlay };
    case 'set_converting':
      return { ...state, converting: action.value };
    case 'set_converting_source':
      return { ...state, convertingSourceId: action.id };
    case 'set_generating':
      return { ...state, generating: action.value };
    case 'set_chatting':
      return { ...state, chatting: action.value };
    case 'record_run':
      return { ...state, runs: [...state.runs, action.run], lastResult: action.result };
    default:
      return state;
  }
}

// ---------- 持久化（仅 sources） ----------

const SOURCES_KEY = 'hh.studio.sources';

function loadSources(): Source[] {
  try {
    const rawJson = localStorage.getItem(SOURCES_KEY);
    if (!rawJson) return [];
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    // 字段级兜底：旧版本/坏数据不让整个应用崩
    return parsed
      .filter((s): s is Source => !!s && typeof s === 'object' && typeof (s as Source).id === 'string')
      .map((s) => ({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '未命名材料',
        kind: s.kind === 'file' || s.kind === 'url' ? s.kind : 'paste',
        raw: typeof s.raw === 'string' ? s.raw : '',
        markdown: typeof s.markdown === 'string' ? s.markdown : '',
        status: s.status === 'converted' ? 'converted' : 'raw',
        enabled: s.enabled !== false,
        meta: {
          charCount: typeof s.meta?.charCount === 'number' ? s.meta.charCount : 0,
          importSummary: s.meta?.importSummary,
          createdAt: typeof s.meta?.createdAt === 'number' ? s.meta.createdAt : 0,
        },
      }));
  } catch {
    return [];
  }
}

// ---------- context ----------

interface StudioContextValue {
  state: StudioState;
  dispatch: Dispatch<StudioAction>;
  /** localStorage 写入失败（配额/隐私模式）——材料只活在本次会话，左栏提示 */
  storageDegraded: boolean;
}

const StudioContext = createContext<StudioContextValue | null>(null);

const INITIAL_CONFIG: GenConfig = {
  // 默认 2 页 = 一张 A4 双面（半开卷常态），与旧界面一致
  targetPages: 2,
  scene: 'auto',
  subject: '',
  orientation: 'portrait',
  marginMm: 10,
  debug: false,
  allowReorder: false,
  stretchFill: true,
  strictSourceOrder: null,
};

export function StudioProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    sources: loadSources(),
    messages: [],
    genConfig: INITIAL_CONFIG,
    modal: null as StudioModal,
    editingSourceId: null,
    pdfOverlay: null,
    converting: false,
    convertingSourceId: null,
    generating: false,
    chatting: false,
    lastResult: null,
    runs: [],
  }));
  const [storageDegraded, setStorageDegraded] = useState(false);

  useEffect(() => {
    try {
      // knowledge 是会话内数据（几百个节点），落盘会顶爆配额——写之前剥掉
      const persistable = state.sources.map(({ knowledge: _knowledge, ...rest }) => rest);
      localStorage.setItem(SOURCES_KEY, JSON.stringify(persistable));
      setStorageDegraded(false);
    } catch {
      setStorageDegraded(true);
    }
  }, [state.sources]);

  return (
    <StudioContext.Provider value={{ state, dispatch, storageDegraded }}>
      {children}
    </StudioContext.Provider>
  );
}

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio 必须在 <StudioProvider> 内使用');
  return ctx;
}

// ---------- 通用小工具 ----------

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 建一条 source；title 缺省从内容首个非空行截取 */
export function makeSource(init: {
  kind: Source['kind'];
  raw: string;
  title?: string;
  markdown?: string;
  status?: Source['status'];
  importSummary?: string;
  knowledge?: KnowledgeDocument;
}): Source {
  const firstLine = init.raw
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return {
    id: newId(),
    title: (init.title || firstLine || '未命名材料').slice(0, 60),
    kind: init.kind,
    raw: init.raw,
    markdown: init.markdown ?? '',
    status: init.status ?? 'raw',
    enabled: true,
    ...(init.knowledge ? { knowledge: init.knowledge } : {}),
    meta: {
      charCount: init.raw.length,
      importSummary: init.importSummary,
      createdAt: Date.now(),
    },
  };
}

/**
 * 排版输入 = enabled 且**已转换**的 sources 按序拼接,空行分隔。
 * 统一输入闸(spec: docs/superpowers/specs/2026-07-28-unified-input-gate-design.md):
 * 生料一律不进排版——这里是最后一道硬保险,上游 generate 会先把生料全部转换。
 */
export function combineForLayout(sources: Source[]): string {
  return sources
    .filter((s) => s.enabled && s.status === 'converted')
    .map((s) => s.markdown)
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}

/** 对话上下文 = enabled 的 sources 按序拼接(已转换用 markdown,生料用 raw)。
 *  对话允许吃生料——「先问问这份材料讲什么再决定转不转」是正当用法,与排版口径刻意不同 */
export function combineForChat(sources: Source[]): string {
  return sources
    .filter((s) => s.enabled)
    .map((s) => (s.status === 'converted' && s.markdown ? s.markdown : s.raw))
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}
