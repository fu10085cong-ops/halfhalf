/** 与后端共享的类型定义 */

export type PaperSize = 'A4' | 'A5' | 'Letter';
export type Density = 'compact' | 'normal' | 'loose';

export interface IterationRecord {
  fontSize: number;
  pages: number;
  withinLimit: boolean;
  timestamp: number;
  message?: string;
}

export interface OptimizeResult {
  optimalFontSize: number;
  actualPages: number;
  iterations: number;
  history: IterationRecord[];
  withinTargetPages: boolean;
  jobId: string;
}