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

// ---------- 数据模型 ----------

export interface Source {
  id: string;
  title: string;
  kind: 'paste' | 'file' | 'url';
  /** 原始生料（粘贴原文/文档提取物） */
  raw: string;
  /** 标准 Markdown（转换产物；「跳过 AI」时 = raw）；未转换为空串 */
  markdown: string;
  status: 'raw' | 'converted';
  /** 是否参与排版（拼接口径：enabled 的按序拼接） */
  enabled: boolean;
  meta: { charCount: number; importSummary?: string; createdAt: number };
}

export interface StructurizeCheck {
  ok: boolean;
  problems: string[];
  blockCount: number;
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
 *  kind 'chat' = 自由对话轮（/api/ai/chat）——只有它进对话历史，动作卡不算 */
export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  kind: 'text' | 'convert' | 'pdf' | 'chat';
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
export type StudioModal = 'compress' | 'diagnostics' | 'history' | 'settings' | null;

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
    generating: false,
    chatting: false,
    lastResult: null,
    runs: [],
  }));
  const [storageDegraded, setStorageDegraded] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(SOURCES_KEY, JSON.stringify(state.sources));
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
    meta: {
      charCount: init.raw.length,
      importSummary: init.importSummary,
      createdAt: Date.now(),
    },
  };
}

/** 排版输入 = enabled 的 sources 按序拼接（已转换用 markdown，生料用 raw），空行分隔 */
export function combineEnabledMarkdown(sources: Source[]): string {
  return sources
    .filter((s) => s.enabled)
    .map((s) => (s.status === 'converted' && s.markdown ? s.markdown : s.raw))
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
}
