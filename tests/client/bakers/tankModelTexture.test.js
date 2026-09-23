import { describe, it, expect, vi } from 'vitest';

// Pixi замокан так же, как в tankTexture.test.js: проверяется раскладка
// атласа, не отрисовка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.points = [];
      this.fills = [];
      this.position = {
        x: 0,
        y: 0,
        set: (x, y) => {
          this.position.x = x;
          this.position.y = y;
        },
      };
    }

    _add(...coords) {
      this.points.push(...coords);
      return this;
    }

    rect(x, y, width, height) {
      return this._add(x, y, x + width, y + height);
    }

    poly(points) {
      return this._add(...points);
    }

    circle(x, y, radius) {
      return this._add(x - radius, y - radius, x + radius, y + radius);
    }

    moveTo(x, y) {
      return this._add(x, y);
    }

    lineTo(x, y) {
      return this._add(x, y);
    }

    closePath() {
      return this;
    }

    fill(color) {
      this.fills.push(color);
      return this;
    }

    stroke() {
      return this;
    }

    getBounds() {
      const xs = this.points.filter((_, i) => i % 2 === 0);
      const ys = this.points.filter((_, i) => i % 2 === 1);
      const x = Math.min(...xs) + this.position.x;
      const y = Math.min(...ys) + this.position.y;

      return {
        x,
        y,
        width: Math.max(...xs) + this.position.x - x,
        height: Math.max(...ys) + this.position.y - y,
      };
    }

    destroy() {}
  }

  class Container {
    constructor() {
      this.children = [];
    }

    addChild(...children) {
      this.children.push(...children);
    }

    getBounds() {
      const all = this.children.map(child => child.getBounds());
      const x = Math.min(...all.map(b => b.x));
      const y = Math.min(...all.map(b => b.y));

      return {
        x,
        y,
        width: Math.max(...all.map(b => b.x + b.width)) - x,
        height: Math.max(...all.map(b => b.y + b.height)) - y,
      };
    }

    destroy() {}
  }

  class Rectangle {
    constructor(x, y, width, height) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
  }

  return { Graphics, Container, Rectangle };
});

const { default: tankModelTexture } =
  await import('../../../src/client/bakers/tankModelTexture.js');

const bake = () =>
  tankModelTexture(
    { colors: { teamId1: 0x552222, teamId2: 0x225522 } },
    { generateTexture: ({ target, frame }) => ({ target, frame }) },
  );

const overlap = (a, b) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('tankModelTexture', () => {
  it('атлас на каждую команду, кадр — весь атлас', () => {
    const atlases = bake();

    for (const team of ['liveTeamId1', 'liveTeamId2']) {
      const { texture, width, height } = atlases[team];

      expect(texture.frame).toEqual(
        expect.objectContaining({ x: 0, y: 0, width, height }),
      );
    }
  });

  it('есть атлас остова с той же раскладкой', () => {
    const atlases = bake();

    expect(atlases.destroyed.regions.body).toEqual(
      atlases.liveTeamId1.regions.body,
    );
  });

  it('области не пересекаются и лежат внутри атласа', () => {
    const { regions, width, height } = bake().liveTeamId1;
    const list = Object.values(regions);

    list.forEach((a, i) => {
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w).toBeLessThanOrEqual(width);
      expect(a.y + a.h).toBeLessThanOrEqual(height);

      list.slice(i + 1).forEach(b => expect(overlap(a, b)).toBe(false));
    });
  });

  it('рисунок корпуса — 40 × 30, центр модели в его середине', () => {
    const { body } = bake().liveTeamId1.regions;

    expect(body.w).toBe(40);
    expect(body.h).toBe(30);
    expect(body.originX).toBe(body.x + 20);
    expect(body.originY).toBe(body.y + 15);
  });
});
