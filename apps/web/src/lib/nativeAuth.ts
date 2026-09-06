import type { Profile } from './types';

const TOKEN_KEY = 'scratchwall.native.session';
const VERIFIER_KEY = 'scratchwall.native.verifier';

export function isNative(): boolean { return Boolean(window.__TAURI_INTERNALS__); }
export function nativeToken(): string | undefined { return isNative() ? localStorage.getItem(TOKEN_KEY) ?? undefined : undefined; }
export function clearNativeToken() { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(VERIFIER_KEY); }

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challenge(verifier: string): Promise<string> {
  return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

export function nativeCallbackCode(url: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== 'scratchwall:') return;
  const route = `${parsed.hostname}${parsed.pathname}`.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  if (route !== 'auth/callback') return;
  return parsed.searchParams.get('code') ?? undefined;
}

async function acceptUrl(url: string): Promise<Profile | undefined> {
  const code = nativeCallbackCode(url);
  if (!code) return;
  const pending = JSON.parse(localStorage.getItem(VERIFIER_KEY) ?? 'null') as { verifier: string; expiresAt: number } | null;
  const verifier = pending && pending.expiresAt > Date.now() ? pending.verifier : undefined;
  if (!verifier) throw new Error('Sign-in expired. Press Continue with VoidAuth again.');
  const response = await fetch('https://scratch.morad.uk/api/v1/auth/native/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier })
  });
  if (!response.ok) throw new Error('Native login exchange failed');
  const result = await response.json();
  localStorage.setItem(TOKEN_KEY, result.sessionToken);
  localStorage.removeItem(VERIFIER_KEY);
  localStorage.removeItem('scratchwall.loggedOut');
  return result.profile as Profile;
}

export async function initializeNativeAuth(
  onAuthenticated: (profile: Profile) => void | Promise<void>,
  onError?: (error: unknown) => void
): Promise<() => void> {
  if (!isNative()) return () => {};
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  const handle = async (urls: string[]) => {
    for (const url of urls) {
      try {
        const profile = await acceptUrl(url);
        if (profile) await onAuthenticated(profile);
      } catch (error) {
        onError?.(error);
      }
    }
  };
  const current = await getCurrent();
  await handle(current ?? []);
  return onOpenUrl(handle);
}

export async function startNativeLogin(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, expiresAt: Date.now() + 600_000 }));
  const value = await challenge(verifier);
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(`https://scratch.morad.uk/api/v1/auth/login?mode=native&codeChallenge=${encodeURIComponent(value)}`);
}
