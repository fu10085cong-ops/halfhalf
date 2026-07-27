/**
 * Lucide 风格线稿图标——path 逐字取自设计稿「HalfHalf 工作台.dc.html」(Organic 规定:
 * stroke-width 2.75、currentColor、17px 常规/14px chevron)。logo 设计语言,不用 emoji。
 */
import type { CSSProperties, ReactNode } from 'react';

function Svg({
  size = 17,
  style,
  children,
}: {
  size?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 品牌 mark:两个并排矩形(Half + Half) */
export const IconLogo = ({ size = 17 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 4h7v16H4z" />
    <path d="M13 4h7v16h-7z" />
  </Svg>
);

/** AI 精简:四角星 */
export const IconSparkle = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M12 3l2 5.5L19.5 11 14 13.5 12 19l-2-5.5L4.5 11 10 8.5z" />
  </Svg>
);

/** 诊断:2×2 方块阵 */
export const IconGrid = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <rect x="13" y="13" width="7" height="7" rx="2" />
  </Svg>
);

/** 会话历史:回转时钟 */
export const IconHistory = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M12 7v5l4 2" />
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 4v4h4" />
  </Svg>
);

/** AI 设置:太阳形旋钮 */
export const IconGear = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
  </Svg>
);

/** 文件(PDF/生成) */
export const IconFile = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
);

/** 排版参数:滑杆 */
export const IconSliders = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M4 6h16M4 12h10M4 18h7" />
    <circle cx="18" cy="12" r="2" />
    <circle cx="13" cy="18" r="2" />
  </Svg>
);

/** 瓦片右下角的入口箭头(40% 透明由使用处控制) */
export const IconChevron = ({ size = 14, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
