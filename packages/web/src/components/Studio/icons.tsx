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

/** 勾(转换完成/进度行) */
export const IconCheck = ({ size = 14, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);

/** 对话气泡(中栏空态) */
export const IconChat = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);

/** 删除:垃圾桶 */
export const IconTrash = ({ size = 15, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M6 7l1 13h10l1-13" />
    <path d="M9 7V4h6v3" />
  </Svg>
);

/** 粘贴文本:剪贴板 */
export const IconClipboard = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M9 4h6v3H9z" />
    <path d="M9 5.5H6v15h12v-15h-3" />
  </Svg>
);

/** 上传文件:文档 */
export const IconDoc = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M14 3H7v18h10V6z" />
    <path d="M14 3v3h3" />
  </Svg>
);

/** 网页链接:链环 */
export const IconLink = ({ size = 17, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 1 0-5.66-5.66l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 1 0 5.66 5.66l1-1" />
  </Svg>
);

/** 硬规则(诊断 trace):挂锁 */
export const IconLock = ({ size = 12, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </Svg>
);

/** 仲裁规则(诊断 trace):天平 */
export const IconScale = ({ size = 12, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M12 3v18" />
    <path d="M7 21h10" />
    <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
    <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1" />
    <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1" />
  </Svg>
);

/** 生料待转换:提示三角 */
export const IconAlert = ({ size = 13, style }: { size?: number; style?: CSSProperties }) => (
  <Svg size={size} style={style}>
    <path d="M12 4L2.5 20h19z" />
    <path d="M12 10v4" />
    <path d="M12 17.5v.01" />
  </Svg>
);
