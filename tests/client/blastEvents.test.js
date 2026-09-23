import { describe, it, expect, vi } from 'vitest';
import { createBlastEvents } from '../../src/client/blastEvents.js';

describe('createBlastEvents', () => {
  it('взрыв доходит до всех подписчиков', () => {
    const blasts = createBlastEvents();
    const a = vi.fn();
    const b = vi.fn();
    const blast = { x: 1, y: 2, radius: 50, level: 0 };

    blasts.subscribe(a);
    blasts.subscribe(b);
    blasts.exploded(blast);

    expect(a).toHaveBeenCalledWith(blast);
    expect(b).toHaveBeenCalledWith(blast);
  });

  it('после отписки взрыв не доходит', () => {
    const blasts = createBlastEvents();
    const a = vi.fn();
    const unsubscribe = blasts.subscribe(a);

    unsubscribe();
    blasts.exploded({ x: 0, y: 0, radius: 50, level: 0 });

    expect(a).not.toHaveBeenCalled();
  });
});
