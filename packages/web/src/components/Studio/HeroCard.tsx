/**
 * 右栏招牌卡「转换 · 排版」——产品特色的门面(类比 NotebookLM 的 Audio Overview 地位)。
 * 一键转换并排版:生料全转(统一输入闸,任一失败即中止)→ 自动生成 PDF;运行中逐份进度可视化。
 * 目标页数与高级选项(场景/学科/方向/边距/开关)也收在这张卡里——右栏只有一个主入口。
 */
import type { SceneId } from '../../types';
import { IconCheck, IconSparkle } from './icons';
import { useStudio } from './useStudioStore';
import { useStudioActions } from './useStudioActions';

const SCENE_OPTIONS: { value: SceneId | 'auto'; label: string }[] = [
  { value: 'auto', label: '自动推荐' },
  { value: 'text-cram', label: '极限文本（背诵型大文本）' },
  { value: 'formula', label: '理科公式（公式不缩小）' },
  { value: 'code', label: '代码密集（代码不折行）' },
  { value: 'visual', label: '图文混排（截图多）' },
  { value: 'balanced', label: '均衡默认' },
];

/** 与服务端 SUBJECT_RULES 的键一致；空串 = 不声明学科 */
const SUBJECT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '不指定' },
  { value: 'calculus', label: '微积分/高数' },
  { value: 'os', label: '操作系统' },
  { value: 'semiconductor', label: '半导体/电路' },
  { value: 'politics', label: '政治/毛概/马原' },
];

export default function HeroCard() {
  const { state, dispatch } = useStudio();
  const { generate } = useStudioActions();
  const cfg = state.genConfig;
  const set = (patch: Partial<typeof cfg>) => dispatch({ type: 'set_config', patch });

  const enabled = state.sources.filter((s) => s.enabled && (s.markdown || s.raw).trim());
  const rawCount = enabled.filter((s) => s.status === 'raw').length;
  const busy = state.converting || state.generating;

  const statusLine =
    enabled.length === 0
      ? '先在左栏添加材料'
      : rawCount > 0
        ? `${enabled.length} 份材料参与 · 其中 ${rawCount} 份生料待转换`
        : `${enabled.length} 份材料参与 · 全部已是标准 Markdown`;

  const buttonLabel = state.converting
    ? '转换中…'
    : state.generating
      ? '排版中…'
      : rawCount > 0
        ? '一键转换并排版'
        : '生成 PDF';

  /** 进度行右侧标签。排版阶段不可能再有生料——统一输入闸保证全转完才排 */
  const rowState = (s: (typeof enabled)[number]): { icon: 'done' | 'spin' | 'wait'; label: string } => {
    if (s.status === 'converted') return { icon: 'done', label: '已转换' };
    if (state.convertingSourceId === s.id) return { icon: 'spin', label: '转换中…' };
    return { icon: 'wait', label: '待转换' };
  };

  return (
    <div className="hh-hero-card">
      <div className="hh-hero-title">
        <IconSparkle />
        转换 · 排版
      </div>
      <div className="hh-hero-status">{statusLine}</div>
      <div className="hh-gen-row">
        <label>
          目标页数
          <input
            type="number"
            min={1}
            max={50}
            value={cfg.targetPages}
            onChange={(e) =>
              // 清空/非法输入兜底到 1，钳在服务端校验的 1~50 区间
              set({ targetPages: Math.min(50, Math.max(1, parseInt(e.target.value) || 1)) })
            }
            style={{ marginLeft: 4 }}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || enabled.length === 0}
          title="生料先自动转换成标准 Markdown，全部就绪后排版;任一份失败会中止并提示"
          onClick={() => void generate()}
        >
          {buttonLabel}
        </button>
      </div>
      {busy && enabled.length > 0 && (
        <div className="hh-hero-progress">
          {enabled.map((s) => {
            const st = rowState(s);
            return (
              <div key={s.id} className="hh-prog-row">
                {st.icon === 'done' && <IconCheck size={12} style={{ color: 'var(--color-accent-2-600)' }} />}
                {st.icon === 'spin' && <span className="hh-spin" />}
                {st.icon === 'wait' && (
                  <span style={{ width: 12, textAlign: 'center', color: 'var(--color-neutral-500)' }}>·</span>
                )}
                <span className="hh-prog-title">{s.title}</span>
                <span className="text-muted">{st.label}</span>
              </div>
            );
          })}
          {state.generating && (
            <div className="hh-prog-row">
              <span className="hh-spin" />
              <span className="hh-prog-title">排版中（二分搜索字号）…</span>
            </div>
          )}
        </div>
      )}
      <details className="hh-advanced">
        <summary>高级选项（场景/学科/边距…）</summary>
        <label>
          场景
          <select value={cfg.scene} onChange={(e) => set({ scene: e.target.value as SceneId | 'auto' })}>
            {SCENE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label title="声明这是什么课：政治类自动允许乱序换密度，操作系统类保护对比表不被缩小">
          学科
          <select value={cfg.subject} onChange={(e) => set({ subject: e.target.value })}>
            {SUBJECT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          方向
          <select
            value={cfg.orientation}
            onChange={(e) => set({ orientation: e.target.value as 'portrait' | 'landscape' })}
          >
            <option value="portrait">竖版</option>
            <option value="landscape">横版</option>
          </select>
        </label>
        <label title="窄边距白捡版面（6mm 约 +7.6%），太窄可能被打印机裁掉">
          边距
          <select value={cfg.marginMm} onChange={(e) => set({ marginMm: Number(e.target.value) })}>
            <option value={10}>标准 10mm</option>
            <option value={8}>紧 8mm</option>
            <option value={6}>窄 6mm</option>
            <option value={4}>极窄 4mm（看打印机）</option>
          </select>
        </label>
        <label title="要点式材料顺序打乱几乎无代价，允许后面的内容填进前面页的空隙；推导/代码类不建议">
          <input
            type="checkbox"
            checked={cfg.allowReorder}
            onChange={(e) => set({ allowReorder: e.target.checked })}
          />
          允许乱序换密度
        </label>
        <label title="定稿后把空隙上方的块字号微放大（≤+2pt）填满空隙；想全文严格等字号就关掉">
          <input
            type="checkbox"
            checked={cfg.stretchFill}
            onChange={(e) => set({ stretchFill: e.target.checked })}
          />
          满版伸展
        </label>
        <label title="PDF 上叠加 24 列网格线与块方框，用于看清排版（不改变排版本身）">
          <input type="checkbox" checked={cfg.debug} onChange={(e) => set({ debug: e.target.checked })} />
          显示网格
        </label>
      </details>
    </div>
  );
}
