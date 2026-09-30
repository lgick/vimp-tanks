# Этап 5. Комментарии и документация (К1, К2, К4) ✅ выполнен

К3 (формулировка в `CHANGELOG.md`) снято: запись уже выпущена в 0.22.11, выпущенные записи не переписываются.

## 5.1. `src/client/blastEvents.js:1–3` (К1)

Шапку переписать: шину будят эффект взрыва (`ExplosionEffectController` — бомба и бочка) и гибель танка
(`WreckFire` — толчок в точке остова); каждый танк сам решает, задел ли его взрыв.

## 5.2. `src/config/render.js:241–243` (К1)

Комментарий над `blastJolt`:

- «визуальная реакция танка на взрыв бомбы или бочки» → «визуальная реакция танка на взрыв бомбы или бочки и на
  гибель танка (`WreckFire`, радиус `wreckFx.joltRadius`)».

## 5.3. Радиус толчка в `architecture.md` (К2)

`docs/en/architecture.md:222–225` и `docs/ru/architecture.md:216–219`. Сейчас там
`{ x, y, radius: wreckFx.joltRadius, level }` (`grep -n joltRadius docs/*/architecture.md`).

- en: `{ x, y, radius, level }` at the wreck, where `radius` is `wreckFx.joltRadius` scaled by `size / referenceSize`
  and `level` is the wreck's physical level;
- ru: `{ x, y, radius, level }` в точке остова, где `radius` — `wreckFx.joltRadius`, масштабированный на
  `size / referenceSize`, а `level` — физический уровень остова.

## 5.4. Длинные строки (К2)

Перенести на ~80 символов, как соседний текст, смысл не менять:

- `docs/en/architecture.md:239–240` («`WreckFire` 4 (its scorch 2), map layers from `data.layer`), so a map without
  upper levels draws exactly as before.»);
- `docs/ru/architecture.md:240` («`Smoke`/вспышка 4, `WreckFire` 4 (его копоть 2), слои карты — из `data.layer`),
  поэтому карта без надземных…»).

Проверка: `git diff --word-diff docs/` в 5.4 — только переносы.

## 5.5. Известное упрощение проекции дыма (К4)

`src/client/parts/WreckFire.js`, в `_render` над `const kHost = this._z * shear;` дописать к существующему
комментарию, по образцу `Smoke.js`:

```js
// Известное упрощение: контейнер стоит в проекции ТЕКУЩЕЙ высоты
// остова, поэтому уже выпущенный столб дыма едет вместе с ним — если
// остов столкнут с моста, столб опустится на новый слой целиком.
// Остов меняет высоту редко, а дым тогда и так тонет под плитой
```

## Проверка этапа

`npx eslint . --quiet`, `npm test -- --silent`: зелёные. CHANGELOG не меняется (комментарии и документация).

> Общий контекст, находки и правила — в [README.md](README.md).
