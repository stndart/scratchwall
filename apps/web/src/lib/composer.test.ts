// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { autosizeTextarea, fitTextarea } from './composer';

describe('fitTextarea', () => {
  it('grows the textarea to its scrollHeight so extra lines are visible', () => {
    const area = document.createElement('textarea');
    Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => 96 });
    fitTextarea(area);
    expect(area.style.height).toBe('96px');
  });

  it('resets height before measuring so the box can shrink after deleting lines', () => {
    const area = document.createElement('textarea');
    area.style.height = '160px';
    Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => 38 });
    fitTextarea(area);
    expect(area.style.height).toBe('38px');
  });
});

describe('autosizeTextarea', () => {
  it('refits on input and when the bound value changes', () => {
    const area = document.createElement('textarea');
    let height = 38;
    Object.defineProperty(area, 'scrollHeight', { configurable: true, get: () => height });
    const action = autosizeTextarea(area, '');
    expect(area.style.height).toBe('38px');
    height = 120;
    area.dispatchEvent(new Event('input'));
    expect(area.style.height).toBe('120px');
    height = 54;
    action.update();
    expect(area.style.height).toBe('54px');
    action.destroy();
    height = 200;
    area.dispatchEvent(new Event('input'));
    expect(area.style.height).toBe('54px');
  });
});
