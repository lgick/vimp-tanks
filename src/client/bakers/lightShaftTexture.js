import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import blurMargin, { blurPadding } from './blurMargin.js';

// детерминированный ГПСЧ (mulberry32): рисунок лучей один на всех клиентах
export function seededRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Лучи фонаря в воздухе: `rays` узких клиньев из центра разной длины и
// яркости, каждый гаснет к концу, края мягкие (размытие). Направления
// равномерны с разбросом. Цвет и силу даёт tint/alpha.
// params.radius - наибольшая длина луча, params.rays - число лучей,
// params.width - полуширина луча на конце (рад), params.strips - полос
// спада по длине, params.seed - рисунок, params.blur - мягкость
// возвращает { texture, contentSize } — contentSize: диаметр лучей
export default function lightShaftTexture(params, renderer) {
  const {
    radius,
    rays = 14,
    width = 0.05,
    strips = 8,
    seed = 1,
    blur = 3,
    quality = 10,
  } = params;
  const graphics = new Graphics();
  const margin = blurMargin(blur);
  const textureSize = (radius + margin) * 2;
  const center = textureSize / 2;
  const random = seededRandom(seed);

  for (let i = 0; i < rays; i += 1) {
    const angle = ((i + (random() - 0.5) * 0.8) / rays) * Math.PI * 2;
    const length = radius * (0.55 + 0.45 * random());
    const brightness = 0.35 + 0.65 * random();
    const half = width * (0.5 + random());
    const cos0 = Math.cos(angle - half);
    const sin0 = Math.sin(angle - half);
    const cos1 = Math.cos(angle + half);
    const sin1 = Math.sin(angle + half);

    // полосы-трапеции вдоль луча: яркий у фонаря, к концу сходит на нет
    for (let s = 0; s < strips; s += 1) {
      const r0 = (length * s) / strips;
      const r1 = (length * (s + 1)) / strips;
      const t = (s + 0.5) / strips;

      graphics.poly([
        center + cos0 * r0,
        center + sin0 * r0,
        center + cos0 * r1,
        center + sin0 * r1,
        center + cos1 * r1,
        center + sin1 * r1,
        center + cos1 * r0,
        center + sin1 * r0,
      ]);
      graphics.fill({ color: 0xffffff, alpha: brightness * (1 - t) });
    }
  }

  const filter = new BlurFilter({ strength: blur, quality });

  // область фильтра шире рамки: мусор пула с края не попадёт в текстуру
  filter.padding = blurPadding(blur);
  graphics.filters = [filter];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, textureSize, textureSize),
  });

  graphics.destroy(true);

  return { texture, contentSize: radius * 2 };
}
