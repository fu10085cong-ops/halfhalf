import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WORKER_PATH = fileURLToPath(new URL('../workers/render_pdf.py', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface PdfVisualRequest {
  id: string;
  page: number;
  bbox?: [number, number, number, number];
}

export interface PdfVisualAsset extends PdfVisualRequest {
  mimeType: 'image/jpeg';
  dataUri: string;
  width: number;
  height: number;
  sizeBytes: number;
}

interface WorkerAsset {
  id: string;
  page: number;
  bbox?: [number, number, number, number];
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  mimeType: 'image/jpeg';
}

interface WorkerResponse {
  assets: WorkerAsset[];
}

export class PdfVisualRendererError extends Error {
  constructor(message: string, public readonly causeDetail?: string) {
    super(message);
    this.name = 'PdfVisualRendererError';
  }
}

async function existingExecutable(candidate: string): Promise<string | null> {
  if (candidate === 'python' || candidate === 'python3') return candidate;
  try {
    await access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function pythonCandidates(): Promise<string[]> {
  const configured = process.env.HALFHALF_PYTHON?.trim();
  const raw = [
    configured,
    path.join(REPO_ROOT, '.venv-parser', 'Scripts', 'python.exe'),
    path.join(REPO_ROOT, '.venv-parser', 'bin', 'python'),
    'python3',
    'python',
  ].filter((candidate): candidate is string => Boolean(candidate));
  const resolved = await Promise.all(raw.map(existingExecutable));
  return [...new Set(resolved.filter((candidate): candidate is string => Boolean(candidate)))];
}

async function runWorker(
  candidates: string[],
  inputPath: string,
  outputDir: string,
  requestsPath: string,
  scale: number,
  quality: number,
  signal?: AbortSignal
): Promise<WorkerResponse> {
  let lastError = '';
  for (const python of candidates) {
    try {
      const { stdout } = await execFileAsync(
        python,
        [
          WORKER_PATH,
          inputPath,
          outputDir,
          '--requests',
          requestsPath,
          '--scale',
          String(scale),
          '--quality',
          String(quality),
        ],
        {
          timeout: 120_000,
          windowsHide: true,
          signal,
          maxBuffer: 4 * 1024 * 1024,
        }
      );
      return JSON.parse(stdout.trim()) as WorkerResponse;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lastError = `${python}: ${detail}`;
      if (!/ENOENT|not found|cannot find/i.test(detail)) break;
    }
  }
  throw new PdfVisualRendererError(
    'PDF visual renderer is unavailable. Install the parser worker dependencies or configure HALFHALF_PYTHON.',
    lastError
  );
}

export async function renderPdfVisualAssets(
  buffer: Buffer,
  requests: PdfVisualRequest[],
  options: { scale?: number; quality?: number; signal?: AbortSignal } = {}
): Promise<PdfVisualAsset[]> {
  if (requests.length === 0) return [];
  const uniqueIds = new Set(requests.map((request) => request.id));
  if (uniqueIds.size !== requests.length) {
    throw new PdfVisualRendererError('PDF visual request ids must be unique.');
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'halfhalf-pdf-visual-'));
  const inputPath = path.join(tempDir, 'source.pdf');
  const requestsPath = path.join(tempDir, 'requests.json');
  const outputDir = path.join(tempDir, 'assets');
  try {
    await writeFile(inputPath, buffer);
    await writeFile(requestsPath, JSON.stringify(requests), 'utf8');
    const candidates = await pythonCandidates();
    const response = await runWorker(
      candidates,
      inputPath,
      outputDir,
      requestsPath,
      options.scale ?? 1.35,
      options.quality ?? 72,
      options.signal
    );
    return await Promise.all(
      response.assets.map(async (asset) => {
        const bytes = await readFile(asset.path);
        return {
          id: asset.id,
          page: asset.page,
          bbox: asset.bbox,
          mimeType: asset.mimeType,
          dataUri: `data:${asset.mimeType};base64,${bytes.toString('base64')}`,
          width: asset.width,
          height: asset.height,
          sizeBytes: bytes.length,
        };
      })
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
