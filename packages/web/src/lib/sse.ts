/**
 * 解析 text/event-stream 帧（event: X / data: JSON），逐帧回调。
 * ChatIntake 与 Studio 对话流共用；契约见 packages/server/API.md 的 /api/ai/structurize。
 */
export async function consumeSse(
  resp: Response,
  on: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      try {
        on(event, JSON.parse(data) as Record<string, unknown>);
      } catch {
        /* 半截帧等异常：跳过单帧，不中断整个流 */
      }
    }
  }
}
