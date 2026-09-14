import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import { randomRange } from 'vimp-engine/lib/math.js';
import blurMargin from './blurMargin.js';

// создаёт набор процедурных текстур копоти: размытое тёмное пятно с ещё
// более тёмной серединой — след разрушенного пропа (бочки), у которого нет
// своей картинки `game.imgDestroyed`. Вариантов несколько, чтобы соседние
// пятна не повторяли один силуэт
// params.baseRadius - Базовый радиус пятна.
// params.irregularity - Степень неровности краёв.
// params.blur - Сила размытия.
// params.numPoints - Количество точек контура.
// params.color - Цвет пятна.
// params.coreColor - Цвет середины.
// params.coreRatio - Доля радиуса, которую занимает середина.
// params.variants - Количество вариантов силуэта.
// renderer - Рендерер PIXI.
// возвращает { textures, contentSize }, где contentSize - диаметр силуэта
// без запаса под размытие: по нему потребитель нормирует масштаб
export default function scorchTexture(params, renderer) {
  const {
    baseRadius,
    irregularity = 0,
    blur = 0,
    numPoints = 16,
    color,
    coreColor = color,
    coreRatio = 0.5,
    variants = 1,
  } = params;

  // хотя бы один силуэт: пустой набор уронил бы потребителя
  const variantCount = Math.max(1, Math.floor(variants) || 1);
  const contentSize = (baseRadius + irregularity) * 2;
  const canvasSize = contentSize + blurMargin(blur) * 2;
  const center = canvasSize / 2;
  const textures = [];

  // неровный замкнутый контур радиуса `radius`
  const blob = (radius, jitter) => {
    const path = [];

    for (let i = 0; i < numPoints; i += 1) {
      const angle = (i / numPoints) * Math.PI * 2;
      const r = radius + randomRange(-jitter, jitter);

      path.push(center + r * Math.cos(angle), center + r * Math.sin(angle));
    }

    return path;
  };

  for (let variant = 0; variant < variantCount; variant += 1) {
    const graphics = new Graphics();

    graphics
      .poly(blob(baseRadius, irregularity))
      .fill(color)
      .poly(blob(baseRadius * coreRatio, irregularity * coreRatio))
      .fill(coreColor);

    const filter = new BlurFilter({ strength: blur, quality: 10 });

    // без явного padding Pixi обрежет размытие раньше рамки холста
    filter.padding = blurMargin(blur);
    graphics.filters = [filter];

    textures.push(
      renderer.generateTexture({
        target: graphics,
        frame: new Rectangle(0, 0, canvasSize, canvasSize),
      }),
    );

    graphics.destroy(true);
  }

  return { textures, contentSize };
}
