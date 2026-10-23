import { describe, expect, it } from 'vitest';
import { EmbeddingProgress, embeddingStatus } from './embeddingProgress';
import { defaultEmbeddingSettings } from './semanticSearch';

const settings = { ...defaultEmbeddingSettings, enabled: true, configured: true, total: 100, done: 20, completeness: 20 };
describe('compact indexing status', () => {
  it('estimates from observed completions and resets after a reindex', () => {
    const progress = new EmbeddingProgress();
    expect(progress.observe(settings, 0)).toBeUndefined();
    expect(progress.observe({ ...settings, done: 30 }, 10_000)).toBe(70);
    expect(progress.observe({ ...settings, done: 0 }, 20_000)).toBeUndefined();
    expect(progress.observe({ ...settings, done: 100 }, 30_000)).toBeUndefined();
  });
  it('shows state and ETA on one line, including failures', () => {
    expect(embeddingStatus(settings, 70)).toBe('Indexing · 20.0% indexed · ~2 min left');
    expect(embeddingStatus(settings)).toContain('Estimating time…');
    expect(embeddingStatus({ ...settings, done: 100 })).toBe('Ready · 100% indexed');
    expect(embeddingStatus({ ...settings, total: 21, failed: 1 })).toBe('20.0% indexed · 1 failed');
  });
});
