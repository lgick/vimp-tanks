# Этап 4. Танки: рендер — согласованность проекции и стоимость кадра

> Часть плана `plan/review-multilevel-3/` — см. индекс
> [README.md](README.md) (контекст, таблица пунктов, принятые решения,
> критерии приёмки). Этот файл самодостаточен для исполнения этапа.
>
> **E** = `/Users/dmitry/Sites/my/vimp` (крейт `vimp-engine-core` + npm
> `vimp-engine`), **T** = `/Users/dmitry/Sites/my/vimp-tanks` (npm
> `@vimp-games/tanks`).
> Коммитов не делать. Любая функциональная правка обновляет `docs/en/` И
> `docs/ru/` и `CHANGELOG.md` под `## [Unreleased]` в том же изменении.
> Пороги `divergence.thresholds` в `tests/scenarios/*.json` не трогать.

Файлы: `src/client/seeThrough.js`, `src/client/levelView.js`,
`src/client/camera.js`, `src/client/parts/Map.js`, `src/client/parts/Tank.js`,
`src/config/client.js`, тесты рядом.

## 4.1 Д8 — дыра и alpha сущностей считаются в разных системах координат

**Проблема.** `src/client/seeThrough.js:53-59` (`seeThroughAlpha`) считает
расстояние по СЫРЫМ мировым точкам:

```js
const dx = x - viewX;
const dy = y - viewY;
const distance = Math.sqrt(dx * dx + dy * dy);
```

А `Map._applyHole` (`src/client/parts/Map.js:809-828`) центрирует дыру по
ПРОЕЦИРОВАННОЙ точке — и правильно: игрок под мостом нарисован не в своей
мировой точке, а смещённым на свою высоту (`offsetPoint(..., z * shear)`).

Сущность на высоте смещена своим множителем (`Map._updateDynamicSeeThrough`,
`Map.js:851-856`; `Tank._updateView`, `Tank.js:346-353`), игрок — своим.
Итог: круг прозрачности точечных сущностей не совпадает с нарисованной
дырой в плите, и расхождение растёт с удалением от центра экрана и с
высотой. Ящик на мосту виден внутри дыры непрозрачным — или гаснет за её
краем.

**Решение.** Считать обе стороны в одной системе — в НАРИСОВАННЫХ
координатах. Формула прозрачности остаётся единственной.

1. `src/client/levelView.js`: сервис уже хранит `z` игрока
   (`state.z`, пишет `Tank.update`, `Tank.js:293-295`). Добавить ему центр
   камеры — либо тем же `set()`, либо отдельным `setCamera(camera)`,
   который зовёт тот, кто и так его считает.
2. `alphaFor(level, worldX, worldY)` перед вызовом `seeThroughAlpha`
   проецирует обе точки:

```js
alphaFor(level, worldX, worldY, z = level) {
  const camera = state.camera;
  const view = offsetPoint(state.x, state.y, camera, state.z * parallax.shear);
  const point = offsetPoint(worldX, worldY, camera, z * parallax.shear);

  return seeThroughAlpha({
    viewLevel: state.level,
    viewX: view.x,
    viewY: view.y,
    level,
    x: point.x,
    y: point.y,
    cfg,
  });
}
```

   `camera === null` (до первого кадра) — `offsetPoint` возвращает точку как
   есть, поведение прежнее.
3. `z` по умолчанию равно `level`: тела, стоящие на плите, ровно на её
   высоте, а танк и дым передают свой дробный `z` (у них он уже есть:
   `Tank.js:276`, `Smoke.js:98`).

**Тест** (`tests/client/…`): игрок в стороне от центра камеры, сущность на
границе дыры — alpha совпадает с тем, что даёт формула фильтра плиты для
той же экранной точки.

## 4.2 Д9 — центр камеры считается по нескольку раз за кадр

**Проблема.** `cameraCenter` (`src/client/camera.js:9`) создаёт объект на
каждый вызов. Вызовы за один кадр:

- `Map._updateStatic` (`Map.js:618`);
- `Map._updateSeeThrough` → `_updateOccluderSeeThrough` (`Map.js:694`);
- `Map._applyHole` (`Map.js:813`);
- по разу на каждый танк (`Tank.js:345`), дым, след, бомбу, эффект.

На карте с четырьмя слоями и десятком сущностей — десятки объектов в кадр
в самом горячем пути, плюс объект на каждый `offsetPoint`.

**Решение (минимальное и достаточное).** Внутри `Map` считать центр ОДИН
раз в `_updateStatic` и прокидывать параметром:

- `_updateStatic()` (`Map.js:605`) считает `camera` первым делом и
  передаёт его в `_updateSeeThrough(camera)`;
- `_updateSeeThrough(cfg, rate, camera)` → `_updateLayerSeeThrough` и
  `_updateOccluderSeeThrough(cfg, rate, camera)`;
- `_applyHole(target, hole, cfg, camera)` больше не зовёт `cameraCenter`
  сам (`Map.js:813`).

Порядок в `_updateStatic` при этом меняется: сейчас `_updateSeeThrough`
зовётся ДО получения камеры (`Map.js:606-622`), и ранний выход
`if (!this._parallaxK && !this._slices.length) return;` стоит между ними.
После правки камера берётся первой, а ранний выход остаётся там же — он
касается только параллакса.

**Если делается 4.1**, центр камеры всё равно нужен сервису `levelView`:
тогда его считает один владелец за кадр (локальный `Tank`, который и так
пишет в `levelView`) и кладёт в сервис, а `Map` читает оттуда. Это
предпочтительный вариант — он закрывает 4.1 и 4.2 одной точкой правды.
Выбранный вариант записать сюда.

## 4.3 Д11 — `_hasLayerTileAt` / `_hasFloorAt`

**Проблема.** `Map.js:861-878` — две функции с одинаковым телом,
отличающиеся только списком тайлов, плюс `Array.prototype.includes` в
пофреймовом цикле (`_volumeHidesPlayer`, `Map.js:763-775`, до
`volume.slices` вызовов на слой в кадр).

**Решение.** Одна приватная функция с набором тайлов параметром; наборы —
`Set`, построенные в конструкторе (`this._tileSet = new Set(data.tiles)`,
`this._floorSet = new Set(data.floor || [])`):

```js
// есть ли в мировой точке тайл из набора: масштаб карты живёт ЗДЕСЬ, а
// грид слоя не масштабирован
_hasTileAt(worldX, worldY, tiles) {
  const col = Math.floor(worldX / this._baseScaleX / this._step);
  const row = Math.floor(worldY / this._baseScaleY / this._step);
  const tile = this._map?.[row]?.[col];

  return tile !== undefined && tiles.has(tile);
}
```

Вызовы: `this._hasTileAt(x, y, this._tileSet)` и
`this._hasTileAt(x, y, this._floorSet)`.

## 4.4 Проверка этапа 4

```bash
npx eslint . && npm test && npm run build && npm run sim:scenarios
```

Приёмка глазами (`npm run dev`, карта `overpass`): заехать под мост,
отъехать в угол экрана — круг прозрачности плиты и прозрачность ящиков на
ней обязаны совпадать по краю (до правки они расходятся тем сильнее, чем
дальше игрок от центра).

`CHANGELOG.md`: `### Fixed` — прозрачность сущностей и дыра в плите
считались в разных координатах.

