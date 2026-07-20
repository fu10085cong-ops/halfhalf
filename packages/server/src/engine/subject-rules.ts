/**
 * 学科层（RULES.md §二 的落地）：编码力学层**测不出**的领域知识——顺序刚性、原子角色。
 * 这层是护城河：算法可抄，真实材料积累出的条目抄不走。
 *
 * 纪律（RULES.md §2.4，防止学科层退化成意见集合）：
 * - 学科规则只能做两件事：① 补充特征（orderRigidity / atomRoles）；② 可行域内的参数建议。
 *   **不得突破力学层硬约束**——硬约束是地板，学科层只能在地板以上活动。
 * - `evidence` 必填且指到具体材料/观察；写不出"哪份材料、什么现象"的规则就是猜的。
 * - 守门问题：「不知道这是什么课，这个问题还能被发现吗？」能 → 力学层的活，禁止进这里。
 * - 学科识别永远只是**建议**（`suggestSubject`），用户声明才作数；识别错了顶多退回
 *   力学层兜底，不会出灾难。
 *
 * 数据存 TS 常量而非 JSON：条目封顶 20~30 条，是配置不是数据；TS 能强制 evidence 必填。
 */

export type AtomRole = 'core' | 'support';

export interface SubjectRule {
  id: string;
  /** 前端下拉框显示名 */
  name: string;
  /** 关键词，用于"建议"识别（非强制，命中越多建议越强） */
  aliases: string[];
  /** 顺序刚性：weak = 要点并列、可乱序换密度（触发 S2）；缺省视为 strong（保守） */
  orderRigidity?: 'strong' | 'weak';
  /** 原子角色：core = 该类原子是知识本体、不能牺牲（表 core 触发 H3） */
  atomRoles?: { table?: AtomRole; image?: AtomRole; formula?: AtomRole };
  /** 可行域内的观感参数建议（不得突破硬约束）；本轮暂无条目使用 */
  suggest?: Partial<{ gutterMm: number; maxAspect: number }>;
  /** 必填：这条规则基于什么真实观察，可追溯（RULES.md §2.4 防退化三条硬规矩之一） */
  evidence: string;
}

/**
 * 初始条目（RULES.md §2.3）。自查：只有 calculus 的 evidence 属于"经验观察"
 * （必须见过真材料才写得出）；其余三条还是"领域常识"级，等真实材料升级。
 */
export const SUBJECT_RULES: Record<string, SubjectRule> = {
  calculus: {
    id: 'calculus',
    name: '微积分/高数',
    aliases: ['微积分', '高等数学', '高数', '极限与连续', '中值定理', '洛必达', '泰勒公式'],
    orderRigidity: 'strong',
    atomRoles: { formula: 'core' },
    evidence:
      '真实材料 test.md（2026-07-15 用户提供）：\\qquad 在一个 $$ 里并排 2~3 个公式是宽度失控主因（泰勒公式块被推到 12 格卡死整页）；28 个独立公式',
  },
  os: {
    id: 'os',
    name: '操作系统',
    aliases: ['操作系统', '进程调度', '页面置换', '死锁', '信号量', '文件系统'],
    orderRigidity: 'strong',
    atomRoles: { table: 'core' },
    evidence:
      'os-large（合成判例）：进程/页面置换对比表是考点本体，不能缩——领域常识级，待真实材料升级',
  },
  semiconductor: {
    id: 'semiconductor',
    name: '半导体/电路',
    aliases: ['半导体', '电路', 'MIS', '能带', 'PN 结', 'C-V', '阈值电压'],
    orderRigidity: 'strong',
    atomRoles: { image: 'core', formula: 'core' },
    evidence: '用户原话"图片优先保原尺寸"（2026-07 会话）；图+公式混合的典型形态',
  },
  politics: {
    id: 'politics',
    name: '政治/毛概/马原',
    aliases: ['马克思', '毛泽东思想', '毛概', '思修', '辩证法', '唯物', '社会主义'],
    orderRigidity: 'weak',
    atomRoles: { table: 'support' },
    evidence: '用户原话"一个问题几个方面"，方面之间逻辑弱、打乱几乎无代价（2026-07 会话）',
  },
};

/**
 * 学科识别建议：按 aliases 在原文里的命中数排序，返回最强的一个（全无命中返回 null）。
 * 只是建议——前端显示"检测到可能是 X 课"，用户点了才算声明（RULES.md §2.2）。
 */
export function suggestSubject(
  markdown: string
): { id: string; name: string; matchedAliases: string[] } | null {
  let best: { id: string; name: string; matchedAliases: string[] } | null = null;
  for (const rule of Object.values(SUBJECT_RULES)) {
    const matched = rule.aliases.filter((a) => markdown.includes(a));
    if (matched.length > 0 && (best === null || matched.length > best.matchedAliases.length)) {
      best = { id: rule.id, name: rule.name, matchedAliases: matched };
    }
  }
  return best;
}
