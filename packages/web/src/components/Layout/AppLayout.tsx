import type { ReactNode } from 'react';

interface AppLayoutProps {
  children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  return (
    <div style={{
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--color-bg)',
    }}>
      {/* Header */}
      <header style={{
        height: 48,
        background: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-border)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 20px',
        boxShadow: 'var(--shadow)',
        zIndex: 10,
      }}>
        <h1 style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--color-primary)',
          letterSpacing: '-0.5px',
        }}>
          📄 HalfHalf
        </h1>
        <span style={{
          marginLeft: 10,
          fontSize: 12,
          color: 'var(--color-text-secondary)',
        }}>
          半开卷小抄生成器 —— 从材料到可打印 PDF
        </span>
        {/* Studio 三栏新界面并存入口（成熟后切默认） */}
        <a
          href="?ui=studio"
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--color-text-secondary)',
            textDecoration: 'none',
          }}
        >
          ✨ 体验新版 Studio
        </a>
      </header>

      {/* Main Content */}
      <main style={{
        flex: 1,
        overflow: 'hidden',
      }}>
        {children}
      </main>
    </div>
  );
}