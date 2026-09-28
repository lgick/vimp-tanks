// Цвета 0xRRGGBB: смешивание по каналам. Чистые функции, PixiJS не нужен

const channel = (color, shift) => (color >> shift) & 0xff;

// a → b по доле t ∈ [0, 1] (t зажимается)
export function lerpColor(a, b, t) {
  const k = Math.min(Math.max(t, 0), 1);
  const mix = shift => {
    const from = channel(a, shift);
    return Math.round(from + (channel(b, shift) - from) * k);
  };

  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

// градиент по опорным точкам `[[доля, цвет], ...]` (доли по возрастанию):
// до первой — первый цвет, после последней — последний
export function colorRamp(stops, t) {
  const [firstAt, firstColor] = stops[0];

  if (t <= firstAt) {
    return firstColor;
  }

  for (let i = 1; i < stops.length; i += 1) {
    const [at, color] = stops[i];

    if (t <= at) {
      const [prevAt, prevColor] = stops[i - 1];
      return lerpColor(prevColor, color, (t - prevAt) / (at - prevAt));
    }
  }

  return stops[stops.length - 1][1];
}
