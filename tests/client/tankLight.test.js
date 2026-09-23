import { describe, it, expect } from 'vitest';
import {
  tankLightUniforms,
  tankLightFactor,
} from '../../src/client/tankLight.js';
import { tiltShade } from '../../src/client/tilt.js';
import { tilt, tankLight } from '../../src/config/render.js';

// JS-зеркало фрагментного шейдера: шейдер без GPU не проверить, а формула
// у них одна (см. src/client/tankLight.js)

const uniforms = overrides =>
  tankLightUniforms({
    heading: 0,
    rotation: 0,
    pitch: 0,
    roll: 0,
    lightDir: tilt.lightDir,
    lightZ: tankLight.lightZ,
    ambient: tankLight.ambient,
    diffuse: tankLight.diffuse,
    ...overrides,
  });

const FLAT = [0, 0, 1];
// фаски корпуса в осях текстуры: корма (−x) и нос (+x), борта ±y
const REAR = [-1, 0, 1];
const LEFT = [0, -1, 1];
const RIGHT = [0, 1, 1];

describe('tankLightFactor', () => {
  it('плоский верх ровного танка не меняется при любом курсе', () => {
    for (const heading of [0, 1, Math.PI / 2, Math.PI, 4]) {
      expect(tankLightFactor(FLAT, uniforms({ heading }))).toBeCloseTo(1, 6);
    }
  });

  // свет с северо-запада: при курсе 0 корма (−x) и борт −y смотрят к нему
  it('фаска к свету светлее, от света — темнее', () => {
    const u = uniforms();

    expect(tankLightFactor(REAR, u)).toBeGreaterThan(1);
    expect(tankLightFactor(LEFT, u)).toBeGreaterThan(1);
    expect(tankLightFactor(RIGHT, u)).toBeLessThan(1);
  });

  it('разворот на π меняет освещённую и теневую стороны местами', () => {
    const north = uniforms();
    const south = uniforms({ heading: Math.PI });

    expect(tankLightFactor(LEFT, south)).toBeCloseTo(
      tankLightFactor(RIGHT, north),
      6,
    );
    expect(tankLightFactor(RIGHT, south)).toBeCloseTo(
      tankLightFactor(LEFT, north),
      6,
    );
  });

  // собственный поворот пушки складывается с курсом
  it('поворот пушки действует как курс', () => {
    expect(
      tankLightFactor(LEFT, uniforms({ rotation: Math.PI / 2 })),
    ).toBeCloseTo(tankLightFactor(LEFT, uniforms({ heading: Math.PI / 2 })), 6);
  });

  // знаки наклона обязаны совпадать со светотенью `tiltShade`: наклон
  // от света затемняет плоский верх, навстречу — не затемняет
  it.each([
    ['pitch', 0.4],
    ['pitch', -0.4],
    ['roll', 0.4],
    ['roll', -0.4],
  ])('знак %s = %f сходится с tiltShade', (axis, angle) => {
    for (const heading of [0, Math.PI / 2, Math.PI]) {
      const tilt3 = { pitch: 0, roll: 0, [axis]: angle };
      const lit = tankLightFactor(FLAT, uniforms({ heading, ...tilt3 }));
      const shade = tiltShade({
        angle: heading,
        ...tilt3,
        lightDir: tilt.lightDir,
        shading: 0.28,
      });

      if (shade < 1) {
        expect(lit).toBeLessThan(1);
      } else {
        expect(lit).toBeGreaterThanOrEqual(1 - 1e-6);
      }
    }
  });

  it('без направления света плоский верх остаётся 1', () => {
    const u = uniforms({ lightDir: undefined });

    expect(tankLightFactor(FLAT, u)).toBeCloseTo(1, 6);
    expect(tankLightFactor(REAR, u)).toBeLessThan(1);
  });
});
