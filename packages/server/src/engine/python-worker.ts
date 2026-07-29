/**
 * Python Worker 的解释器探测。两个 Worker（原页保真 render_pdf.py、栅格质检 inspect_pdf.py）
 * 共用同一套候选顺序，别各写一份——探测顺序改了只改一处。
 *
 * 顺序：HALFHALF_PYTHON（Docker 里固定 /usr/bin/python3）→ 仓库内 .venv-parser → PATH 上的 python3/python。
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

async function existingExecutable(candidate: string): Promise<string | null> {
  // PATH 上的名字交给 execFile 自己找，不做 access 检查
  if (candidate === 'python' || candidate === 'python3') return candidate;
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export async function pythonCandidates(): Promise<string[]> {
  const raw = [
    process.env.HALFHALF_PYTHON?.trim(),
    path.join(REPO_ROOT, '.venv-parser', 'Scripts', 'python.exe'),
    path.join(REPO_ROOT, '.venv-parser', 'bin', 'python'),
    'python3',
    'python',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const resolved = await Promise.all(raw.map(existingExecutable));
  return [...new Set(resolved.filter((candidate): candidate is string => Boolean(candidate)))];
}
