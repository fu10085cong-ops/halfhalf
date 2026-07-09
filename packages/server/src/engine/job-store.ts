/** 内存态的 PDF 任务存储（MVP 阶段够用；重启进程或水平扩容后需要换成 Redis/对象存储）*/

interface Job {
  pdfBuffer: Buffer;
  createdAt: number;
}

const JOB_TTL_MS = 30 * 60 * 1000;

const jobs = new Map<string, Job>();

export function saveJob(jobId: string, pdfBuffer: Buffer): void {
  jobs.set(jobId, { pdfBuffer, createdAt: Date.now() });
  cleanupExpiredJobs();
}

export function getJob(jobId: string): Job | undefined {
  return jobs.get(jobId);
}

function cleanupExpiredJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
