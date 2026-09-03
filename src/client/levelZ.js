// Шаг zIndex между уровнями 2.5D-карты. Порядок отрисовки внутри уровня
// задают базовые zIndex партов (см. plan/stage_6.md); шаг обязан быть
// больше любого базового, иначе слой моста провалится под наземный навес.
export const LEVEL_Z_STRIDE = 100;

export const levelZ = (base, level) => base + LEVEL_Z_STRIDE * (level || 0);
