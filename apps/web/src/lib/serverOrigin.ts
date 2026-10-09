export function nativeServerOrigin() {
  return (import.meta.env.VITE_API_BASE || 'http://localhost:8080').replace(/\/$/, '');
}
