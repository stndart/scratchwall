import type { EmbeddingSettings } from './semanticSearch';

/** Short, per-view estimate. Never guess a rate before observing real progress. */
export class EmbeddingProgress {
  private samples: Array<{ time: number; done: number }> = [];

  observe(settings: EmbeddingSettings, time = Date.now()): number | undefined {
    const remaining = Math.max(0, settings.total - settings.done - settings.failed);
    if (!settings.enabled || !remaining) { this.samples = []; return; }
    if (this.samples.length && settings.done < this.samples.at(-1)!.done) this.samples = [];
    this.samples.push({ time, done: settings.done });
    while (this.samples.length > 2 && this.samples[1].time < time - 120_000) this.samples.shift();
    const first = this.samples[0];
    const completed = settings.done - first.done;
    return completed > 0 && time > first.time ? remaining * (time - first.time) / completed / 1000 : undefined;
  }
}

export function embeddingStatus(settings: EmbeddingSettings, eta?: number): string {
  if (!settings.configured) return 'Unavailable on this server';
  if (!settings.enabled) return 'Off';
  if (settings.done >= settings.total) return 'Ready · 100% indexed';
  const percentage = `${settings.completeness.toFixed(1)}% indexed`;
  if (settings.failed && settings.done + settings.failed >= settings.total) return `${percentage} · ${settings.failed} failed`;
  const estimate = eta === undefined ? 'Estimating time…'
    : eta < 60 ? `~${Math.max(10, Math.ceil(eta / 10) * 10)} sec left`
    : eta < 3600 ? `~${Math.ceil(eta / 60)} min left` : `~${Math.ceil(eta / 3600)} hr left`;
  return `Indexing · ${percentage} · ${estimate}`;
}
