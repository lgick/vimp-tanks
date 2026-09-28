# Этап 2. Чистые помощники (без PixiJS) ✅ выполнен

## 2.1 `src/client/colorRamp.js` (новый)

```js
// Цвета 0xRRGGBB: смешивание по каналам. Чистые функции, PixiJS не нужен

// a → b по доле t ∈ [0, 1] (t зажимается)
export function lerpColor(a, b, t) { /* по каналам R, G, B: Math.round(lerp) */ }

// градиент по опорным точкам `[[доля, цвет], ...]` (доли по возрастанию):
// до первой — первый цвет, после последней — последний
export function colorRamp(stops, t) { /* найти пару соседних опор, lerpColor */ }
```

Тест `tests/client/colorRamp.test.js`: `lerpColor(0x000000, 0xffffff, 0.5) === 0x808080`;
концы `0`/`1`; зажим `t < 0`, `t > 1`; `colorRamp` на опоре возвращает её цвет, между опорами —
смешивание, за краями — крайние цвета; одна опора — всегда её цвет.

## 2.2 `src/client/wreckTimeline.js` (новый)

Все функции берут секции конфига параметрами (тестируемость без моков):

```js
// Таймлайн пожара остова (src/client/parts/WreckFire.js): чистые функции
// времени с момента гибели, мс

// сила пламени: 1 всё `fire.duration`, затем линейно до 0 за `fire.fadeOut`
// (`fadeOut` 0 — гаснет сразу)
export function fireIntensity(elapsed, fire) {}

// конец пожара, мс
export function fireEnd(fire) { return fire.duration + fire.fadeOut; }

// частота дыма, частиц/с: пока горит — от `tailRate` до `rate` по силе
// пламени; после — от `tailRate` линейно до 0 за `smoke.tail`
export function smokeRate(elapsed, fire, smoke) {}

// когда перестаёт рождаться последняя частица
export function emissionEnd(fire, smoke) { return fireEnd(fire) + smoke.tail; }

// прозрачность клуба дыма по доле жизни t: проявление за первые 12 %,
// плато, угасание с 45 % до конца (форма SmokeEffect)
export function smokeAlpha(t, peak) {}
```

Защита от деления на ноль: `fadeOut`/`tail` `<= 0` → мгновенно (`!(x > 0)`).

Тест `tests/client/wreckTimeline.test.js`: `fireIntensity` = 1 при 0 и при `duration`, 0.5 в
середине затухания, 0 после `fireEnd`, `fadeOut: 0`; `smokeRate` = `rate` в начале, `tailRate` в
`fireEnd`, половина `tailRate` в середине хвоста, 0 после `emissionEnd`; `smokeAlpha` — 0 при
`t = 0`, `peak` на плато, 0 при `t = 1`.

> Общий контекст, факты из кода и решение — в [README.md](README.md).
