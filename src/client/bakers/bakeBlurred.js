import { BlurFilter, Rectangle } from 'pixi.js';
import { blurPadding } from './blurMargin.js';

// Выпечка фигуры с размытием — одно место на все баркеры. padding фильтра —
// `blurPadding(blur)`: промежуточные проходы BlurFilter пишут во временную
// текстуру пула без очистки, и при меньшем padding мусор прошлых кадров
// ложится светлой рамкой по краю текстуры (см. blurMargin.js). Кадр —
// `width × height` от (0, 0): запас `blurMargin(blur)` вокруг фигуры
// закладывает вызывающий. Фигура и фильтр после выпечки освобождаются —
// `Container.destroy` фильтры не уничтожает
export default function bakeBlurred(
  renderer,
  target,
  { blur, quality = 10, width, height },
) {
  const filter = new BlurFilter({ strength: blur, quality });

  filter.padding = blurPadding(blur);
  target.filters = [filter];

  const texture = renderer.generateTexture({
    target,
    frame: new Rectangle(0, 0, width, height),
  });

  target.destroy(true);
  filter.destroy();

  return texture;
}
