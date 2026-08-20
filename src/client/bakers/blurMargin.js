// запас прозрачных пикселей вокруг фигуры под размытие
// BlurFilter Pixi (ядро 5, несколько проходов) даёт сигму ≈ 1.29 * strength,
// а носитель цепочки ядер обрывается на 2 * s0 * (1 + 1/2 + 1/4 + ...)
// ≈ 3.46 * strength (s0 ≈ 0.866 * strength - сила первого прохода),
// поэтому 4 * strength гарантированно покрывает размытие
// без запаса generateTexture обрезает размытие рамкой,
// и спрайт получает видимый прямоугольный край
// ВАЖНО: запас работает только в паре с filter.padding = blurMargin(blur),
// иначе Pixi сам обрежет фильтр на 2 * strength вокруг фигуры
const BLUR_SPREAD_FACTOR = 4;

export default function blurMargin(strength) {
  return Math.ceil(strength * BLUR_SPREAD_FACTOR);
}
