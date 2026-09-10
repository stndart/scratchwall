/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

export {};
