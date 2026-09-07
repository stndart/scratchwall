import type { Attachment, PendingOperation, Profile, SyncRequest, SyncResponse } from './types';
import { applyServerChanges, attachmentSource, cacheNativeStream, getCursor, pendingOperations, putAttachment, rejectOperation } from './repository';
import { clearNativeToken, isNative, nativeToken, startNativeLogin } from './nativeAuth';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
let requests = new AbortController();
let silentRefresh: Promise<boolean> | undefined;
export function cancelRequests() {
  requests.abort();
  requests = new AbortController();
}
export function apiOrigin() { return isNative() && !API_BASE ? 'https://scratch.morad.uk' : API_BASE; }
function canTransfer() { return navigator.onLine && document.visibilityState !== 'hidden' && !localStorage.getItem('scratchwall.loggedOut'); }

export class UnauthorizedError extends Error {}

export function silentLoginUrl(): string {
  return `${apiOrigin()}/api/v1/auth/login?mode=web&silent=1`;
}

export async function silentReauth(): Promise<boolean> {
  if (isNative() || localStorage.getItem('scratchwall.loggedOut')) return false;
  if (!silentRefresh) silentRefresh = runSilentReauth().finally(() => { silentRefresh = undefined; });
  return silentRefresh;
}

async function runSilentReauth(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('hidden', '');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    iframe.src = silentLoginUrl();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      window.clearInterval(poll);
      window.clearTimeout(timer);
      iframe.remove();
      resolve(ok);
    };
    const poll = window.setInterval(() => {
      void fetch(`${apiOrigin()}/api/v1/auth/me`, { credentials: 'include' })
        .then((response) => { if (response.ok) finish(true); })
        .catch(() => { /* still unauthorized or offline */ });
    }, 400);
    const timer = window.setTimeout(() => finish(false), 8_000);
    iframe.addEventListener('load', () => {
      try {
        const href = iframe.contentWindow?.location.href ?? '';
        if (!href) return;
        const url = new URL(href);
        if (url.origin !== location.origin) return;
        if (url.searchParams.get('auth') === 'required') finish(false);
      } catch { /* still on the identity provider */ }
    });
    document.body.append(iframe);
  });
}

async function request(path: string, init: RequestInit = {}, retried = false) {
  const headers = new Headers(init.headers);
  const token = nativeToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(`${apiOrigin()}${path}`, { credentials: 'include', signal: requests.signal, ...init, headers });
  if (response.status === 401) {
    if (!retried && await silentReauth()) return request(path, init, true);
    throw new UnauthorizedError('Sign in required');
  }
  if (!response.ok) {
    const contentType = response.headers.get('content-type') ?? '';
    const body = contentType.includes('text/plain') || contentType.includes('application/json')
      ? (await response.text()).slice(0, 500) : '';
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return response;
}

export async function me(): Promise<Profile> {
  return request('/api/v1/auth/me').then((response) => response.json());
}

export async function login() {
  localStorage.removeItem('scratchwall.loggedOut');
  if (isNative()) { await startNativeLogin(); return; }
  location.assign(`${API_BASE}/api/v1/auth/login?mode=web`);
}

export async function logout() {
  const token = nativeToken();
  localStorage.setItem('scratchwall.loggedOut', 'true');
  clearNativeToken();
  try {
    if (navigator.onLine) await request('/api/v1/auth/logout', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
  } finally {
    clearNativeToken();
  }
}

export async function syncOnce(): Promise<SyncResponse> {
  const operations = (await pendingOperations()).slice(0, 500);
  const body: SyncRequest = { cursor: await getCursor(), operations, limit: 1000 };
  const response: SyncResponse = await request('/api/v1/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((value) => value.json());
  const rejectedIds = new Set(response.rejected.map((item) => item.id));
  await applyServerChanges(response.changes, response.acknowledged.filter((id) => !rejectedIds.has(id)), response.cursor);
  for (const rejection of response.rejected) await rejectOperation(rejection.id, rejection.reason);
  return response;
}

export async function syncUntilCaughtUp() {
  let response: SyncResponse;
  do response = await syncOnce(); while (response.hasMore || (await pendingOperations()).length > 0);
}

export async function uploadPendingAttachments(attachments: Attachment[]) {
  for (const attachment of attachments.filter((item) => !item.remoteReady && ['local', 'error'].includes(item.cacheState))) {
    if (!canTransfer()) return;
    const local = await attachmentSource(attachment.id);
    if (!local) continue;
    try {
      const created = await request('/api/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: attachment.id,
          memoId: attachment.memoId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          thumbnail: attachment.thumbnail
        })
      }).then((value) => value.json() as Promise<{ id: string; offset: number }>);
      let offset = created.offset;
      const chunkSize = 8 * 1024 * 1024;
      while (offset < local.size) {
        if (!canTransfer()) return;
        const chunk = await local.slice(offset, Math.min(offset + chunkSize, local.size));
        const result = await request(`/api/v1/uploads/${created.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
          body: chunk
        }).then((value) => value.json() as Promise<{ offset: number }>);
        offset = result.offset;
      }
      await request(`/api/v1/uploads/${created.id}/complete`, { method: 'POST' });
      await putAttachment({ ...attachment, remoteReady: true, cacheState: 'cached' });
    } catch (error) {
      await putAttachment({ ...attachment, cacheState: 'error' });
    }
  }
}

export function fileUrl(id: string) {
  const origin = isNative() && !API_BASE ? 'https://scratch.morad.uk' : API_BASE;
  return `${origin}/api/v1/files/${encodeURIComponent(id)}`;
}

export async function downloadAttachment(id: string): Promise<Blob> {
  return request(`/api/v1/files/${encodeURIComponent(id)}`).then((response) => response.blob());
}

export async function downloadNativeAttachment(attachment: Attachment) {
  const response = await request(`/api/v1/files/${encodeURIComponent(attachment.id)}`);
  if (!response.body) throw new Error('Download returned no file');
  await cacheNativeStream(attachment, response.body);
}

export function connectChanges(onChange: () => void): () => void {
  if (isNative()) return () => {};
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = API_BASE ? new URL(API_BASE) : location;
  const socket = new WebSocket(`${protocol}//${base.host}/api/v1/changes`);
  socket.addEventListener('message', onChange);
  return () => socket.close();
}
