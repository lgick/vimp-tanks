import { Graphics, Rectangle } from 'pixi.js';
import { randomRange } from 'vimp-engine/lib/math.js';

// создаёт набор текстур щепок для разлёта при разрушении пропа: узкие
// неровные четырёхугольники вдоль холста. Рисуются белым (params.color),
// цвет обломков задаёт tint спрайта
// params.length - Длина щепки и сторона квадратного холста.
// params.width - Наибольшая толщина щепки.
// params.color - Цвет заливки.
// params.variants - Количество вариантов силуэта.
// renderer - Рендерер PIXI.
// возвращает { textures, contentSize }, где contentSize - длина щепки:
// по ней потребитель нормирует масштаб
export default function debrisTexture(params, renderer) {
  const { length, width, color, variants = 1 } = params;
  const variantCount = Math.max(1, Math.floor(variants) || 1);
  const middle = length / 2;
  const textures = [];

  for (let variant = 0; variant < variantCount; variant += 1) {
    const graphics = new Graphics();
    // толщина у концов разная: щепка, а не ровный брусок
    const head = randomRange(width * 0.3, width) / 2;
    const tail = randomRange(width * 0.1, width * 0.6) / 2;

    graphics
      .poly([
        0,
        middle - tail,
        length,
        middle - head,
        length,
        middle + head,
        0,
        middle + tail,
      ])
      .fill(color);

    textures.push(
      renderer.generateTexture({
        target: graphics,
        frame: new Rectangle(0, 0, length, length),
      }),
    );

    graphics.destroy(true);
  }

  return { textures, contentSize: length };
}
