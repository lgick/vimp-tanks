# Этап 5. Эффекты: тригонометрия огненного шара и `rng` клуба дыма (К2, К3) ✅ выполнен

**Файлы:** `src/client/parts/effects/shot/MuzzleFlashEffect.js`, `src/client/parts/effects/shot/PuffEffect.js`,
`tests/client/parts/effects/PuffEffect.test.js`. Рефакторинг и тестируемость: docs и CHANGELOG не трогать.

## Проблемы (проверено)

1. **К2.** `muzzleFlashShape` (`MuzzleFlashEffect.js`, ~стр. 104–176) вызывается каждый кадр, пока горят языки
   (`t < 1`, 80–110 мс, то есть 5–7 кадров). Огненный шар на каждый слой заново считает единичный круг: 12 пар
   `Math.cos`/`Math.sin` на слой, при трёх слоях 72 вызова на вспышку за кадр. Вспышек до двух на выстрел (дуло и
   разрыв). Нагрузка небольшая, так что это чистка, а не узкое место: круг от кадра к кадру не меняется. Цвет
   слоя (`layer.core ? config.coreColor : config.color`) вычисляется в двух местах: в цикле языков и в цикле шара.
2. **К3.** `PuffEffect` (`PuffEffect.js`, конструктор, ~стр. 104) делает
   `sprite.rotation = randomRange(0, Math.PI * 2)`. `randomRange` из `vimp-engine/lib/math.js` берёт глобальный
   `Math.random` в обход внедрённого `rng`, хотя конструктор принимает `rng` ровно для детерминизма в тестах:
   `rollPuffs(config, dirX, dirY, rng)`.

## Решение

### 5.1. Единичный круг шара (`MuzzleFlashEffect.js`)

Сразу после

```js
// вершин у многоугольника огненного шара: на радиусе в пару единиц мира
// граней не видно
const BALL_SIDES = 12;
```

добавить

```js
// единичный круг шара: вершины не меняются от кадра к кадру — считаются раз
// на модуль, а не каждый кадр на каждый слой
const BALL_UNIT = Array.from({ length: BALL_SIDES }, (_, i) => {
  const angle = (i / BALL_SIDES) * Math.PI * 2;

  return [Math.cos(angle), Math.sin(angle)];
});
```

В `muzzleFlashShape` цикл шара

```js
      const radius = config.ball.radius * layer.scale * size;
      const points = [];

      for (let i = 0; i < BALL_SIDES; i += 1) {
        const angle = (i / BALL_SIDES) * Math.PI * 2;

        points.push(Math.cos(angle) * radius, Math.sin(angle) * radius);
      }
```

заменить на

```js
      const radius = config.ball.radius * layer.scale * size;
      const points = [];

      for (const [unitX, unitY] of BALL_UNIT) {
        points.push(unitX * radius, unitY * radius);
      }
```

`flatMap` не использовать: он аллоцирует массив на каждую вершину.

### 5.2. Цвет слоя в одном месте

В начале `muzzleFlashShape`, рядом с `const baseAngle = …`, объявить

```js
  const layerColor = layer => (layer.core ? config.coreColor : config.color);
```

- В цикле языков `const color = layer.core ? config.coreColor : config.color;` → `const color = layerColor(layer);`.
- В цикле шара `color: layer.core ? config.coreColor : config.color,` → `color: layerColor(layer),`.

Порядок полигонов не менять: сначала языки и боковые выбросы всех слоёв, потом шары всех слоёв. На это есть тест
`'огненный шар: круг в дуле на каждый слой, после языков всех слоёв'`
(`tests/client/parts/effects/MuzzleFlashEffect.test.js`).

### 5.3. `rng` для поворота клуба (`PuffEffect.js`)

- В конструкторе `sprite.rotation = randomRange(0, Math.PI * 2);` → `sprite.rotation = rng() * Math.PI * 2;`.
- Импорт `import { clamp, randomRange } from 'vimp-engine/lib/math.js';` → `import { clamp } from 'vimp-engine/lib/math.js';`.
  `randomRange` в файле больше нигде не используется: `rollPuffs` берёт свой `range`.

Поворот тянет `rng` после `rollPuffs`, поэтому последовательность значений у клубов прежняя.

### 5.4. Тест детерминизма (`PuffEffect.test.js`)

В `describe('PuffEffect', …)` после теста `'спрайт на клуб, завершается по самому долгому клубу'` добавить

```js
  // поворот клуба — из внедрённого rng, а не из Math.random: эффект
  // детерминирован в тестах
  it('поворот спрайтов берётся из rng', () => {
    const effect = new PuffEffect(
      0,
      0,
      1,
      0,
      () => {},
      assets,
      impactSmoke,
      fixed(0.5),
    );

    effect.sprites.forEach(sprite =>
      expect(sprite.rotation).toBeCloseTo(Math.PI, 10),
    );
  });
```

`fixed`, `assets` и `impactSmoke` в файле уже объявлены или импортированы (стр. 7–13). С `Math.random` тест упал бы.

## Проверка

```bash
npx vitest run tests/client/parts/effects --reporter=dot
npx eslint . --quiet
npx vitest run --reporter=dot
```

## Критерий готовности

- В `muzzleFlashShape` нет `Math.cos`/`Math.sin` для шара; `layerColor` используется в обоих циклах.
- В `PuffEffect.js` нет `randomRange`. Новый тест зелёный и с `Math.random` был бы красным.
- Все тесты и линтер зелёные.
