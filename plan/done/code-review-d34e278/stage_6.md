# Этап 6. Ослабленные проверки и история в комментариях (Т1–Т3) ✅ выполнен

**Файлы:** `tests/core/core.test.js`, `src/data/weapons.js`, `tests/client/parts/effects/MuzzleFlashEffect.test.js`.
Тесты и комментарии: docs и CHANGELOG не трогать.

## Проблемы (проверено)

1. **Т1.** `tests/core/core.test.js`, тест `'танк разгоняется вперёд и подтверждает seq ввода'` (~стр. 99–110).
   Порог просто уменьшили с `100` до `50` под новую скорость: `expect(x).toBeGreaterThan(50);`. При следующей
   правке `models.js` он снова сломается. А в этом же коммите для `w1`/`w2` тики правильно выведены из конфига
   (`W1_COOLDOWN_TICKS`, `W2_FUSE_TICKS`, ~стр. 23–28). Факт: за 120 тиков с места (карта не загружена) танк
   проходит x ≈ 97 при потолке 130 ед/с, то есть ≈75 % пути на полном ходу за то же время.
2. **Т2.** `src/data/weapons.js`, комментарий к `w1.impulseMagnitude` (стр. 5–9): «…снижен с 7500000 (в 5 раз)
   вместе со скоростью танка». История живёт в CHANGELOG и git, комментарий должен объяснять текущее значение.
   Импульс прикладывается в точке попадания: `core/src/tanks.rs`, `process_hitscan`,
   `body.apply_impulse_at_point(dir * impulse_magnitude, impact, true)`.
3. **Т3.** `tests/client/parts/effects/MuzzleFlashEffect.test.js`, тест
   `'без sideLength боковых выбросов нет (вспышка разрыва)'` (~стр. 46–49). Первой строкой он проверяет значение
   конфига `expect(impactFlash.sideLength).toBe(0);`, то есть данные, а не поведение, и сломается при тюнинге.
   `impactFlash` в этом файле больше нигде не используется: импорт на стр. 8.

## Решение

### 6.1. Порог разгона из конфига (Т1)

В тесте заменить

```js
      stepTicks(core, 120);

      const [x, y] = core.position_of(1);

      expect(x).toBeGreaterThan(50);
```

на

```js
      const ticks = 120;

      stepTicks(core, ticks);

      const [x, y] = core.position_of(1);

      // за секунду разгона с места танк проходит заметную долю пути на полном
      // ходу — порог из модели, а не число под текущую скорость
      expect(x).toBeGreaterThan(models.m1.maxForwardSpeed * ticks * DT * 0.4);
```

`models` импортирован (стр. 3), `DT = 1 / 120` объявлен (стр. 21). Порог при 130 — 52, факт ≈97. Остальные
проверки теста (`Math.abs(y) < 1`, `last_input_seq`) не трогать.

### 6.2. Комментарий к импульсу `w1` (Т2)

В `src/data/weapons.js` комментарий над `impulseMagnitude: 1500000,` заменить на

```js
    // сила импульса (кг*м/с); не масштабируется дальностью выстрела в ядре
    // (TanksSim::process_hitscan). Прикладывается в точке попадания и
    // разворачивает танк, поэтому держится малой относительно массы танка
```

Значение не менять.

### 6.3. Тест поведения вместо данных (Т3)

Тест заменить на

```js
  it('sideLength 0 — боковых выбросов нет', () => {
    const roll = rollMuzzleFlash({ ...muzzleFlash, sideLength: 0 }, fixed(0.5));

    expect(roll.sides).toEqual([]);
  });
```

Базой взят `muzzleFlash`: у него `sideLength` 6, так что переопределение на `0` содержательно. Затем в импорте
`import { muzzleFlash, impactFlash } from '../../../../src/config/render.js';` убрать `impactFlash`:
`import { muzzleFlash } from '../../../../src/config/render.js';`. Перед этим проверить
`grep -n impactFlash tests/client/parts/effects/MuzzleFlashEffect.test.js`: других использований быть не должно.
Если они появились, импорт оставить.

## Проверка

```bash
npm run core:build     # только если core/pkg-node нет или устарел: тесты ядра без него скипаются
npx vitest run tests/core tests/client/parts/effects --reporter=dot
npx eslint . --quiet
npx vitest run --reporter=dot
```

Убедиться, что тесты `tests/core` действительно выполнились, а не пропущены (`describe.skipIf(!coreAvailable)`):
в отчёте vitest не должно быть skipped по `core.test.js`.

## Критерий готовности

- Порог разгона выводится из `models.m1.maxForwardSpeed`. В `weapons.js` нет истории, в тесте вспышки нет
  проверки значения конфига.
- Тесты и линтер зелёные.
