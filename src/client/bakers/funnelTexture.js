import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import { randomRange } from 'vimp-engine/lib/math.js';
import blurMargin from './blurMargin.js';

// создаёт набор процедурных текстур воронки: тёмная выемка со светлым бортиком
// двухтоновая заливка нужна, чтобы след читался и на светлых, и на тёмных картах
// вариантов несколько, чтобы у воронок не был один и тот же силуэт
// params.baseRadius - Базовый радиус фигуры.
// params.irregularity - Степень неровности краев.
// params.blur - Сила размытия.
// params.numPoints - Количество точек для построения кривой.
// params.colorFill - Цвет выемки.
// params.colorRim - Цвет бортика по контуру.
// params.rimWidth - Толщина бортика.
// params.variants - Количество вариантов силуэта.
// renderer - Рендерер PIXI.
// возвращает { textures, contentSize }, где contentSize - диаметр силуэта
// (без запаса под размытие): по нему потребитель нормирует масштаб
export default function funnelTexture(params, renderer) {
  const {
    baseRadius,
    irregularity = 0,
    blur = 0,
    numPoints = 20,
    colorFill,
    colorRim = colorFill,
    rimWidth = 0,
    variants = 1,
  } = params;

  // силуэт всегда хотя бы один: пустой набор уронил бы FunnelEffect
  const variantCount = Math.max(1, Math.floor(variants) || 1);
  const contentSize = (baseRadius + irregularity + rimWidth) * 2;
  const canvasSize = contentSize + blurMargin(blur) * 2;
  const center = canvasSize / 2;
  const textures = [];

  for (let variant = 0; variant < variantCount; variant += 1) {
    const graphics = new Graphics();
    const path = [];

    for (let i = 0; i < numPoints; i += 1) {
      const angle = (i / numPoints) * Math.PI * 2;
      const r = baseRadius + randomRange(-irregularity, irregularity);

      path.push(center + r * Math.cos(angle), center + r * Math.sin(angle));
    }

    // бортик рисуется наружу, чтобы не съедать выемку
    graphics
      .poly(path)
      .fill(colorFill)
      .stroke({ width: rimWidth, color: colorRim, alignment: 1 });

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
