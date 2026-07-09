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
          Markdown 自动分页排版系统
        </span>
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