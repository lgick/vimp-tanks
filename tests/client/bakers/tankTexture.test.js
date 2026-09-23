import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяются кадры запекания и цвета карты нормалей, не
// отрисовка. Габарит фигуры мок считает по точкам рисования
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

const {
  default: tankTexture,
  normalColor,
  FLAT_NORMAL,
} = await import('../../../src/client/bakers/tankTexture.js');

const bake = () => {
  const renderer = {
    generateTexture: ({ target, frame }) => ({ target, frame }),
  };

  return tankTexture(
    { colors: { teamId1: 0x552222, teamId2: 0x225522 } },
    renderer,
  );
};

describe('tankTexture', () => {
  it('корпус — ровно 40 × 30 с центром в начале координат', () => {
    const { frame } = bake().liveTeamId1.body;

    expect(frame).toEqual(
      expect.objectContaining({ x: -20, y: -15, width: 40, height: 30 }),
    );
  });

  // карта нормалей ложится на цветную текстуру пиксель в пиксель: кадр у
  // них один и тот же
  it('карты нормалей запечены в кадр своей цветной текстуры', () => {
    const textures = bake();

    for (const team of ['liveTeamId1', 'liveTeamId2']) {
      const live = textures[team];

      expect(live.bodyNormal.frame).toEqual(live.body.frame);
      expect(live.gunNormal.frame).toEqual(live.gun.frame);
    }

    expect(textures.destroyedNormal.frame).toEqual(textures.destroyed.frame);
  });

  it('якорь пушки — центр башни внутри кадра', () => {
    const { gun, gunAnchor } = bake().liveTeamId1;

    expect(gunAnchor.x).toBeCloseTo(-gun.frame.x / gun.frame.width, 6);
    expect(gunAnchor.y).toBeCloseTo(-gun.frame.y / gun.frame.height, 6);
    // ствол торчит вперёд: центр башни в задней половине кадра
    expect(gunAnchor.x).toBeLessThan(0.5);
    expect(gunAnchor.y).toBeCloseTo(0.5, 6);
  });

  it('у остова карта нормалей плоская', () => {
    const { destroyedNormal } = bake();

    expect(destroyedNormal.target.fills).toEqual([FLAT_NORMAL]);
  });

  it('фаски корпуса смотрят наружу', () => {
    const { fills } = bake().liveTeamId1.bodyNormal.target;

    expect(fills[0]).toBe(FLAT_NORMAL);
    expect(fills).toContain(normalColor(-1, 0, 1));
    expect(fills).toContain(normalColor(0, -1, 1));
    expect(fills).toContain(normalColor(0, 1, 1));
    // лобовой лист у носа `+x`
    expect(fills).toContain(normalColor(1, 0, 2));
  });
});

describe('normalColor', () => {
  it('плоская нормаль — (128, 128, 255)', () => {
    expect(FLAT_NORMAL).toBe(0x8080ff);
  });

  it('нормирует вектор и кодирует оси по каналам', () => {
    // скат к корме под 45°: x = −√½ → 37, z = √½ → 218
    expect(normalColor(-1, 0, 1)).toBe((37 << 16) | (128 << 8) | 218);
    expect(normalColor(0, 2, 0)).toBe((128 << 16) | (255 << 8) | 128);
  });
});
