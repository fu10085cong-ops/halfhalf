/**
 * 右栏 Studio：生成主卡常驻 + 模块卡（精简/诊断/历史/AI 设置 + dev 测试材料）。
 * 点模块卡 → 本栏滑入对应面板（← 返回）——二级界面形态之一（栈式面板）。
 */
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api';
import type { FixtureInfo } from '../../types';
import GenerateCard from './GenerateCard';
import { AiSettingsPanel, CompressPanel, DiagnosticsPanel, HistoryPanel } from './panels';
import { makeSource, useStudio, type RailPanel } from './useStudioStore';

const MODULE_CARDS: { panel: RailPanel; title: string; hint: string }[] = [
  { panel: 'compress', title: '✨ AI 精简', hint: '叙述改要点，逐块建议可勾选' },
  { panel: 'diagnostics', title: '🔍 诊断报告', hint: '最近一次生成的引擎细节' },
  { panel: 'history', title: '🕘 会话历史', hint: '每次生成一行，改参对照' },
  { panel: 'settings', title: '⚙️ AI 设置', hint: '端点 / 模型 / API Key' },
];

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
    <div className="hh-studio-card">
      <b className="hh-card-title">🧪 测试材料</b>
      <small>packages/server/test/fixtures（仅开发环境）</small>
      <div className="hh-gen-row">
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="">选择 fixture…</option>
          {fixtures.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}（{f.sizeKb}KB）
            </option>
          ))}
        </select>
        <button type="button" className="hh-btn-secondary" onClick={() => void load()} disabled={!sel}>
          添加为材料
        </button>
      </div>
      {error && <div className="hh-msg-err">{error}</div>}
    </div>
  );
}

export default function StudioRail() {
  const { state, dispatch } = useStudio();

  if (state.railPanel !== 'cards') {
    return (
      <div className="studio-col">
        <div className="studio-col-head">🎛 功能</div>
        <div className="studio-col-body">
          <button
            type="button"
            className="hh-panel-back"
            onClick={() => dispatch({ type: 'set_rail', panel: 'cards' })}
          >
            ← 返回功能列表
          </button>
          {state.railPanel === 'compress' && <CompressPanel />}
          {state.railPanel === 'diagnostics' && <DiagnosticsPanel />}
          {state.railPanel === 'history' && <HistoryPanel />}
          {state.railPanel === 'settings' && <AiSettingsPanel />}
        </div>
      </div>
    );
  }

  return (
    <div className="studio-col">
      <div className="studio-col-head">🎛 功能</div>
      <div className="studio-col-body">
        <GenerateCard />
        {MODULE_CARDS.map((c) => (
          <div
            key={c.panel}
            className="hh-studio-card is-clickable"
            onClick={() => dispatch({ type: 'set_rail', panel: c.panel })}
          >
            <b className="hh-card-title">{c.title}</b>
            <small>{c.hint}</small>
          </div>
        ))}
        <FixturesCard />
      </div>
    </div>
  );
}
