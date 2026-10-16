// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { swipeToOpen } from './swipe';

afterEach(() => document.body.replaceChildren());
describe('swipe to open spaces', () => {
  function setup(enabled = true) {
    const node = document.createElement('main');
    node.innerHTML = '<p>Memo</p><textarea></textarea><pre>Code</pre>';
    document.body.append(node);
    const open = vi.fn();
    const action = swipeToOpen(node, { enabled: () => enabled, open });
    function touch(type: string, x: number, y: number, selector = 'p', count = 1) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const point = { clientX: x, clientY: y };
      Object.assign(event, { touches: type === 'touchend' ? [] : Array(count).fill(point), changedTouches: [point] });
      node.querySelector(selector)!.dispatchEvent(event);
      return event;
    }
    return { touch, open, action };
  }
  it('opens after a deliberate right swipe and stops intercepting after cleanup', () => {
    const { touch, open, action } = setup();
    touch('touchstart', 40, 100);
    expect(touch('touchmove', 90, 105).defaultPrevented).toBe(true);
    touch('touchend', 150, 110);
    expect(open).toHaveBeenCalledTimes(1);
    action.destroy();
    touch('touchstart', 40, 100);
    touch('touchend', 150, 110);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it.each(['textarea', 'pre'])('leaves %s interactions alone', (selector) => {
    const { touch, open } = setup();
    touch('touchstart', 40, 100, selector);
    expect(touch('touchmove', 150, 100, selector).defaultPrevented).toBe(false);
    touch('touchend', 150, 100, selector);
    expect(open).not.toHaveBeenCalled();
  });
  it('leaves vertical scrolling, left swipes, multiple touches, and disabled views alone', () => {
    const { touch, open } = setup();
    for (const [x, y, count] of [[45, 140, 1], [10, 100, 1], [100, 100, 2]]) {
      touch('touchstart', 40, 100);
      expect(touch('touchmove', x, y, 'p', count).defaultPrevented).toBe(false);
      touch('touchend', 150, 100);
    }
    expect(open).not.toHaveBeenCalled();
    const disabled = setup(false);
    disabled.touch('touchstart', 40, 100);
    disabled.touch('touchend', 150, 100);
    expect(disabled.open).not.toHaveBeenCalled();
  });
});
