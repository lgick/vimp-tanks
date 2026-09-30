import { describe, it, expect } from 'vitest';
import { createVolumes } from '../../src/client/volumes.js';

// Сервис `volumes`: высоты объёмов по клеткам уровней от слоёв карты.
describe('volumes', () => {
  const geometry = { step: 32, scale: 1 };

  it('высота объёма в клетке слоя; вне клеток и на другом уровне — 0', () => {
    const volumes = createVolumes();

    volumes.setLayerVolume(0, [[3, 1]], 1, {}, geometry);

    expect(volumes.heightAt(0, 100, 40)).toBe(1);
    expect(volumes.heightAt(0, 10, 40)).toBe(0);
    expect(volumes.heightAt(0, -5, -5)).toBe(0);
    expect(volumes.heightAt(1, 100, 40)).toBe(0);
    expect(volumes.cellSize()).toEqual({ cellW: 32, cellH: 32 });
  });

  it('масштаб карты входит в размер клетки', () => {
    const volumes = createVolumes();

    volumes.setLayerVolume(
      0,
      [[1, 1]],
      0.5,
      {},
      { step: 32, scale: { x: 2, y: 1 } },
    );

    expect(volumes.cellSize()).toEqual({ cellW: 64, cellH: 32 });
    expect(volumes.heightAt(0, 70, 40)).toBe(0.5);
  });

  it('два слоя на клетке — выигрывает больший объём', () => {
    const volumes = createVolumes();

    volumes.setLayerVolume(0, [[0, 0]], 0.35, {}, geometry);
    volumes.setLayerVolume(0, [[0, 0]], 1, {}, geometry);

    expect(volumes.heightAt(0, 5, 5)).toBe(1);
  });

  it('release снимает вклад слоя, пересборка — после правок', () => {
    const volumes = createVolumes();
    const low = {};
    const high = {};

    volumes.setLayerVolume(0, [[0, 0]], 0.35, low, geometry);
    volumes.setLayerVolume(0, [[0, 0]], 1, high, geometry);
    expect(volumes.heightAt(0, 5, 5)).toBe(1);

    volumes.release(high);
    expect(volumes.heightAt(0, 5, 5)).toBe(0.35);

    volumes.setLayerVolume(1, [[2, 2]], 0.25, high, geometry);
    expect(volumes.heightAt(1, 70, 70)).toBe(0.25);

    volumes.release(low);
    volumes.release(high);
    expect(volumes.heightAt(0, 5, 5)).toBe(0);
    expect(volumes.heightAt(1, 70, 70)).toBe(0);
  });

  it('без слоёв — 0', () => {
    expect(createVolumes().heightAt(0, 5, 5)).toBe(0);
  });

  it('version растёт на вкладе и снятии известного слоя', () => {
    const volumes = createVolumes();
    const walls = {};

    expect(volumes.version).toBe(0);

    volumes.setLayerVolume(0, [[0, 0]], 1, walls, geometry);
    expect(volumes.version).toBe(1);

    volumes.release({});
    expect(volumes.version).toBe(1);

    volumes.release(walls);
    expect(volumes.version).toBe(2);
  });

  it('levels() группирует вклады по уровням, release убирает владельца', () => {
    const volumes = createVolumes();
    const bridge = {};

    volumes.setLayerVolume(0, [[0, 0]], 1, {}, geometry);
    volumes.setLayerVolume(0, [[1, 0]], 0.35, {}, geometry);
    volumes.setLayerVolume(1, [[2, 0]], 1, bridge, geometry);

    const levels = volumes.levels();

    expect([...levels.keys()].sort()).toEqual([0, 1]);
    expect(levels.get(0)).toHaveLength(2);
    expect(levels.get(1)).toEqual([{ cells: [[2, 0]], volume: 1 }]);

    volumes.release(bridge);

    expect(volumes.levels().has(1)).toBe(false);
    expect(volumes.levels().get(0)).toHaveLength(2);
  });
});
