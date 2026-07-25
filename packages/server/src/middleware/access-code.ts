/**
 * 访问口令闸门（部署用）：设置 env HALFHALF_ACCESS_CODE 后启用，覆盖 /api/*，
 * 仅放行 /api/health（探活/监控）。口令跟随每个请求的 x-access-code 头，
 * 前端首次 401 时向用户要一次、存 localStorage（见 web/src/api.ts）。
 *
 * 定位是"挡住路人和扫描器"的轻量门槛，不是账号体系——口令是全站共享的一串字符，
 * 发给谁用完全由部署者线下控制。
 */
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export function accessCodeGuard(expectedCode: string) {
  const expected = Buffer.from(expectedCode);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === '/health') {
      next();
      return;
    }
    const got = Buffer.from(String(req.headers['x-access-code'] ?? ''));
    // 长度相同才能 timingSafeEqual；长度不同直接判否（长度本身不算秘密）
    const ok = got.length === expected.length && timingSafeEqual(got, expected);
    if (!ok) {
      res.status(401).json({ error: '需要访问口令（x-access-code 请求头），请向部署者索取' });
      return;
    }
    next();
  };
}
