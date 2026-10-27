import type { ServerMsg } from '@af/shared';
import { handleMessage, useStore } from './store';
import { toast } from './ui';

function token() {
  const fromUrl = new URLSearchParams(location.search).get('token');
  try {
    if (fromUrl) localStorage.setItem('af-token', fromUrl);
    return fromUrl ?? localStorage.getItem('af-token') ?? '';
  } catch {
    return fromUrl ?? '';
  }
}

/** 工作区文件的只读直链（预览、新窗口打开、下载） */
export function workspaceUrl(path: string) {
  return useStore.getState().previewBase + path.split('/').map(encodeURIComponent).join('/');
}

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as any).error ?? `请求失败 ${res.status}`;
    if (toast) toast.error(msg);
    else alert(msg);
    throw new Error((data as any).error);
  }
  return data as T;
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`);
  ws.onopen = () => useStore.setState({ connected: true });
  ws.onmessage = (e) => handleMessage(JSON.parse(e.data) as ServerMsg);
  ws.onclose = () => {
    useStore.setState({ connected: false });
    setTimeout(connect, 2000);
  };
}
