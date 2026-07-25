/**
 * 统一的 API 请求入口：自动携带访问口令头（部署环境的 HALFHALF_ACCESS_CODE 闸门），
 * 首次 401 时向用户要一次口令、存 localStorage 后自动重试。
 * 本地开发没设口令时零感知（服务端不启用闸门，永远不会 401 到这里）。
 */
const CODE_KEY = 'hh.access.code';

function getAccessCode(): string {
  try {
    return localStorage.getItem(CODE_KEY) ?? '';
  } catch {
    return '';
  }
}

function setAccessCode(v: string): void {
  try {
    localStorage.setItem(CODE_KEY, v);
  } catch {
    /* 隐私模式禁用 localStorage：本次会话内每次 401 都会再问 */
  }
}

export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const doFetch = () => {
    const headers = new Headers(init?.headers);
    const code = getAccessCode();
    if (code) headers.set('x-access-code', code);
    return fetch(input, { ...init, headers });
  };
  let resp = await doFetch();
  if (resp.status === 401) {
    const entered = window.prompt('本站需要访问口令（向部署者索取）：');
    if (entered && entered.trim()) {
      setAccessCode(entered.trim());
      resp = await doFetch();
    }
  }
  return resp;
}
