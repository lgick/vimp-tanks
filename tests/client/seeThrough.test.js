import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  seeThroughAlpha,
  seeThroughTint,
} from '../../src/client/seeThrough.js';
import { seeThrough } from '../../src/config/render.js';

// Единственная формула прозрачности 2.5D: её зовут и плита, и ящик, и чужой
// танк, и дым, и эффекты. Разъедься она между партами — ящик остался бы
// висеть непрозрачным пятном в дыре, проделанной в плите под ним.
describe('seeThroughAlpha', () => {
  const hole = { ...seeThrough, mode: 'hole' };
  const layer = { ...seeThrough, mode: 'layer' };

  const alpha = (cfg, { viewLevel, level, x = 0, y = 0 }) =>
    seeThroughAlpha({
      viewLevel,
      viewX: 0,
      viewY: 0,
      level,
      x,
      y,
      cfg,
    });

  it('свой уровень виден целиком', () => {
    expect(alpha(hole, { viewLevel: 1, level: 1 })).toBe(1);
  });

  it('уровень ниже игрока виден целиком (его закрывает tint, а не alpha)', () => {
    expect(alpha(hole, { viewLevel: 1, level: 0 })).toBe(1);
    expect(seeThroughTint(1, 0, hole)).toBe(hole.lowerTint);
    expect(seeThroughTint(1, 1, hole)).toBe(0xffffff);
  });

  it("режим 'hole': выше и рядом — гаснет до минимума", () => {
    expect(alpha(hole, { viewLevel: 0, level: 1, x: 0 })).toBeCloseTo(
      hole.minAlpha,
      5,
    );
  });

  it("режим 'hole': выше, но за краем дыры — видно как есть", () => {
    const far = hole.radius * 2;

    expect(alpha(hole, { viewLevel: 0, level: 1, x: far })).toBe(1);
  });

  it("режим 'hole': на затухании прозрачность растёт с расстоянием", () => {
    const inner = hole.radius * (1 - hole.softness);
    const near = alpha(hole, { viewLevel: 0, level: 1, x: inner + 1 });
    const mid = alpha(hole, {
      viewLevel: 0,
      level: 1,
      x: (inner + hole.radius) / 2,
    });

    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(1);
  });

  it("режим 'layer': гаснет весь уровень целиком, расстояние не при чём", () => {
    expect(alpha(layer, { viewLevel: 0, level: 1, x: 0 })).toBe(
      layer.layerAlpha,
    );
    expect(alpha(layer, { viewLevel: 0, level: 1, x: 10000 })).toBe(
      layer.layerAlpha,
    );
  });
});

// Шейдер «дыры» проверяется чтением исходника: без GL-контекста слинковать
// программу негде, а ошибка тут молчаливая — Pixi объявляет uInputSize и
// uOutputFrame в defaultFilter.vert с точностью highp, во фрагменте
// точность float по умолчанию mediump, и линковка падает в консоль
// («Could not initialize shader»), а карта продолжает рисоваться без дыры.
describe('шейдер дыры', () => {
  // не import.meta.url: проект `tanks` крутится в jsdom, где это не file://
  const source = readFileSync('src/client/seeThrough.js', 'utf8');

  it('фрагментный шейдер объявляет precision highp float', () => {
    const glsl = source.slice(
      source.indexOf('const fragment = `'),
      source.indexOf('const wgsl = `'),
    );

    expect(glsl).toContain('precision highp float;');
    expect(glsl.indexOf('precision highp float;')).toBeLessThan(
      glsl.indexOf('uniform vec4 uInputSize;'),
    );
  });
});
