import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import ParticleChannel from '../../../src/client/parts/ParticleChannel.js';

// Канал частиц: контейнер, массив симуляции и пул держатся в согласии —
// каждая частица в items ровно одна в контейнере, потолок `max` жёсткий

const make = (options = {}) =>
  new ParticleChannel({
    texture: Texture.EMPTY,
    max: 3,
    padding: 100,
    ...options,
  });

describe('ParticleChannel', () => {
  it('не рождает частиц сверх потолка max', () => {
    const channel = make();

    for (let i = 0; i < 3; i += 1) {
      expect(channel.spawn({ id: i })).not.toBeNull();
    }

    expect(channel.spawn({ id: 3 })).toBeNull();
    expect(channel.size).toBe(3);
    expect(channel.container.particleChildren.length).toBe(channel.size);
  });

  it('spawn выдаёт частице вид из пула с текстурой канала', () => {
    const channel = make();
    const sim = channel.spawn({});

    expect(sim.view).toBeDefined();
    expect(sim.view.texture).toBe(Texture.EMPTY);
    expect(channel.container.particleChildren).toContain(sim.view);
  });

  it('removeAt убирает ровно одну частицу и из контейнера', () => {
    const channel = make();
    const a = channel.spawn({ id: 'a' });
    const b = channel.spawn({ id: 'b' });
    const c = channel.spawn({ id: 'c' });

    channel.removeAt(1);

    expect(channel.items).toEqual([a, c]);
    expect(channel.container.particleChildren).toEqual([a.view, c.view]);
    expect(channel.container.particleChildren).not.toContain(b.view);
  });

  it('clear обнуляет и контейнер, и items; канал пригоден снова', () => {
    const channel = make();

    channel.spawn({});
    channel.spawn({});
    channel.clear();

    expect(channel.size).toBe(0);
    expect(channel.container.particleChildren.length).toBe(0);

    expect(channel.spawn({})).not.toBeNull();
    expect(channel.container.particleChildren.length).toBe(1);
  });

  it('применяет режим смешивания (по умолчанию normal)', () => {
    expect(make().container.blendMode).toBe('normal');
    expect(make({ blendMode: 'add' }).container.blendMode).toBe('add');
  });

  it('follow двигает boundsArea вслед за эмиттером', () => {
    const channel = make();

    channel.follow(300, -50);

    const area = channel.container.boundsArea;

    expect(area.x).toBe(200);
    expect(area.y).toBe(-150);
    expect(area.width).toBe(200);
    expect(area.height).toBe(200);
  });
});
