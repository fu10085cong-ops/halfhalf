/**
 * 右栏 成果/功能：生成主卡常驻 + 2×2 功能瓦片（赤陶/沙绿交替,点开为居中弹窗——
 * Organic 弹窗语言,二级内容不再挤压一级内容）+ dev 测试材料卡（沙绿标注）。
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api';
import type { FixtureInfo } from '../../types';
import GenerateCard from './GenerateCard';
import Modal from './Modal';
import { IconChevron, IconGear, IconGrid, IconHistory, IconSparkle } from './icons';
import { AiSettingsPanel, CompressPanel, DiagnosticsPanel, HistoryPanel } from './panels';
import { makeSource, useStudio, type StudioModal } from './useStudioStore';

/** 瓦片语言逐字取自设计稿:线稿图标在上、粗体标题 + 40% 透明 chevron 在下,
 *  neutral/沙绿底交替,无说明文字、无 emoji(logo 设计语言) */
const TILES: {
  modal: Exclude<StudioModal, null>;
  icon: typeof IconSparkle;
  title: string;
  hint: string;
}[] = [
  { modal: 'compress', icon: IconSparkle, title: 'AI 精简', hint: '叙述改要点,逐块勾选建议' },
  { modal: 'diagnostics', icon: IconGrid, title: '诊断报告', hint: '最近一次生成的引擎细节' },
  { modal: 'history', icon: IconHistory, title: '会话历史', hint: '改参对照,每次生成一行' },
  { modal: 'settings', icon: IconGear, title: 'AI 设置', hint: '服务商 / 模型 / API Key' },
];

const MODAL_META: Record<Exclude<StudioModal, null>, { title: string; width: number }> = {
  compress: { title: 'AI 精简', width: 860 },
  diagnostics: { title: '诊断报告', width: 760 },
  history: { title: '会话历史', width: 700 },
  settings: { title: 'AI 设置', width: 560 },
};

/** dev 环境的测试材料速载（生产环境接口 404，整卡自动隐藏） */
function FixturesCard() {
  const { dispatch } = useStudio();
  const [fixtures, setFixtures] = useState<FixtureInfo[]>([]);
  const [sel, setSel] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/fixtures')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.fixtures) setFixtures(d.fixtures as FixtureInfo[]);
      })
      .catch(() => {});
  }, []);

  if (fixtures.length === 0) return null;

  const load = async () => {
    if (!sel) return;
    try {
      const r = await apiFetch(`/api/fixtures/${encodeURIComponent(sel)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      const md = d.markdown as string;
      // fixture 已是标准 Markdown：直接算已转换,免 AI
      dispatch({
        type: 'add_source',
        source: makeSource({ kind: 'paste', raw: md, markdown: md, status: 'converted', title: sel }),
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="hh-fixtures-card">
      <b style={{ fontSize: 13 }}>测试材料</b>
      <div className="text-muted" style={{ fontSize: 11 }}>
        packages/server/test/fixtures（仅开发环境）
      </div>
      <div className="hh-gen-row">
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          <option value="">选择 fixture…</option>
          {fixtures.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}（{f.sizeKb}KB）
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={!sel}>
          添加为材料
        </button>
      </div>
      {error && <div className="hh-msg-err">{error}</div>}
    </div>
  );
}

export default function StudioRail() {
  const { state, dispatch } = useStudio();
  const open = state.modal;

  return (
    <div className="studio-col is-right">
      <div className="studio-col-head">成果与功能</div>
      <div className="studio-col-body">
        <GenerateCard />
        <div className="hh-tiles">
          {TILES.map((t) => {
            const TileIcon = t.icon;
            return (
              <button
                key={t.modal}
                type="button"
                className="hh-tile"
                title={t.hint}
                onClick={() => dispatch({ type: 'set_modal', modal: t.modal })}
              >
                <span className="hh-tile-icon">
                  <TileIcon />
                </span>
                <span className="hh-tile-row">
                  <b>{t.title}</b>
                  <IconChevron style={{ opacity: 0.4 }} />
                </span>
              </button>
            );
          })}
        </div>
        <FixturesCard />
      </div>
      {open && (
        <Modal
          title={MODAL_META[open].title}
          width={MODAL_META[open].width}
          onClose={() => dispatch({ type: 'set_modal', modal: null })}
        >
          {open === 'compress' && <CompressPanel />}
          {open === 'diagnostics' && <DiagnosticsPanel />}
          {open === 'history' && <HistoryPanel />}
          {open === 'settings' && <AiSettingsPanel />}
        </Modal>
      )}
    </div>
  );
}
