// Generate a private Tauri override; the server URL never enters tracked config.
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
try { process.loadEnvFile(resolve('.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const url = new URL(process.env.VITE_API_BASE || 'http://localhost:8080');
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
  throw new Error('VITE_API_BASE must be a plain HTTP(S) origin');
}
const ws = url.origin.replace(/^http/, 'ws');
const config = {
  ...(process.env.NATIVE_IDENTIFIER ? { identifier: process.env.NATIVE_IDENTIFIER } : {}),
  app: { security: { csp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${url.origin} ${ws}; img-src 'self' data: blob: ${url.origin}; media-src 'self' blob: ${url.origin}; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` } },
};
await writeFile('apps/web/src-tauri/tauri.local.json', JSON.stringify(config,null,2)+'\n');
console.log('Generated apps/web/src-tauri/tauri.local.json');
