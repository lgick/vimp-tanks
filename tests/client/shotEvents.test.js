import { describe, it, expect, vi } from 'vitest';
import { createShotEvents } from '../../src/client/shotEvents.js';

describe('createShotEvents', () => {
  it('выстрел будит подписчика своего id', () => {
    const shots = createShotEvents();
    const callback = vi.fn();

    shots.subscribe('7', { fired: callback });
    shots.fired('7');

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('чужой id не срабатывает', () => {
    const shots = createShotEvents();
    const callback = vi.fn();

    shots.subscribe('7', { fired: callback });
    shots.fired('8');

    expect(callback).not.toHaveBeenCalled();
  });

  // id контекста парта и id из строки трассера бывают разных типов
  it('строковый и числовой id — один ключ', () => {
    const shots = createShotEvents();
    const callback = vi.fn();

    shots.subscribe('7', { fired: callback });
    shots.fired(7);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('после отписки выстрел не доходит', () => {
    const shots = createShotEvents();
    const callback = vi.fn();
    const unsubscribe = shots.subscribe('7', { fired: callback });

    unsubscribe();
    shots.fired('7');

    expect(callback).not.toHaveBeenCalled();
  });

  it('muzzle отдаёт точку дула подписчика, чужой id — null', () => {
    const shots = createShotEvents();

    shots.subscribe('7', { muzzle: () => ({ x: 1, y: 2 }) });

    expect(shots.muzzle(7)).toEqual({ x: 1, y: 2 });
    expect(shots.muzzle('8')).toBe(null);
  });

  it('подписчик без дула (остов) даёт null', () => {
    const shots = createShotEvents();

    shots.subscribe('7', { muzzle: () => null });

    expect(shots.muzzle('7')).toBe(null);
  });
});
