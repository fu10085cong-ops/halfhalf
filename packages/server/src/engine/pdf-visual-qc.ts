/**
 * 栅格质检：把成品 PDF 真栅格化一遍，查两类几何算不出来的失败——
 * **整页几乎空白**（渲染崩了但页数对得上）和 **墨迹贴物理边缘**（会被打印机切掉）。
 *
 * 与 `isAcceptableTrial` 的分工：那个基于拼装几何预测"塞不塞得下"，这个检查
 * **真正会被下载的那串字节**。几何说没问题而像素说空白，只有栅格看得见。
 *
 * 依赖只有 PyMuPDF（requirements.txt 里已有，原页保真 Worker 也用它），不引入新依赖。
 * Worker 缺失时返回 `available:false`，**绝不阻断导出**——它是诊断，不是硬闸。
 * （2026-07-29 从 feat/document-intelligence-complete 分支捞回）
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pythonCandidates } from './python-worker.js';

const execFileAsync = promisify(execFile);
const WORKER_PATH = fileURLToPath(new URL('../workers/inspect_pdf.py', import.meta.url));

export interface RasterPageCheck {
  /** 非白像素占比 */
  inkRatio: number;
  blank: boolean;
  nearEdge: boolean;
  /** 墨迹外接框，归一化到 0~1；整页空白时为 null */
  bounds: [number, number, number, number] | null;
}

export interface RasterVisualCheck {
  available: boolean;
  pages: RasterPageCheck[];
  issues: string[];
}

export async function inspectRenderedPdf(pdfBuffer: Buffer): Promise<RasterVisualCheck> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'halfhalf-pdf-qc-'));
  const inputPath = path.join(tempDir, 'output.pdf');
  try {
    await writeFile(inputPath, pdfBuffer);
    let detail = '';
    for (const python of await pythonCandidates()) {
      try {
        const { stdout } = await execFileAsync(python, [WORKER_PATH, inputPath], {
          timeout: 60_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        const parsed = JSON.parse(stdout) as { pages: RasterPageCheck[] };
        const issues = parsed.pages.flatMap((page, index) => [
          ...(page.blank ? [`第 ${index + 1} 页栅格检查发现几乎空白`] : []),
          ...(page.nearEdge ? [`第 ${index + 1} 页内容贴近物理边缘`] : []),
        ]);
        return { available: true, pages: parsed.pages, issues };
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      available: false,
      pages: [],
      issues: [`栅格质检不可用：${detail || 'Python/PyMuPDF 未就绪'}`],
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
