# План: осколки попадания на склоне рампы лежат на склоне

План самодостаточен: исполнителю не нужен контекст переписки. Перед началом прочитать `CLAUDE.md` в корне
репозитория (правила кода, тестов, документации и CHANGELOG). Коммитов не делать: все правки остаются в
рабочем дереве.

## Статус этапов

| Этап | Суть                                                   | Статус      |
| ---- | ------------------------------------------------------ | ----------- |
| 1    | `rampSurfaceAt` — высота поверхности рампы в точке     | ✅ выполнен |
| 2    | Сервис `rampRuns.heightAt` и проводка зависимости      | ✅ выполнен |
| 3    | `reproject` в `parallax.js`, вспышка у дула через него | ✅ выполнен |
| 4    | `ImpactEffect`: высота на каждый осколок и `project`   | ✅ выполнен |
| 5    | `ShotEffectController`: `surfaceK` и `_placeDebris`    | ✅ выполнен |
| 6    | Документация en/ru и CHANGELOG                         | ✅ выполнен |
| 7    | Итоговая проверка                                      | ✅ выполнен |

Выполненный этап отмечать тегом «✅ выполнен» у заголовка и в таблице. Когда выполнены все этапы, перенести файл
в `plan/done/` (`git mv plan/ramp-debris-parallax.md plan/done/`, без коммита).

---

## Контекст

### Симптом

Найдено при ручной проверке задачи `plan/done/night-city-fixes-review.md` (коммиты 14decad, a0a2e1e). Если
стрелять в рампу, осколки попадания, оставшиеся на склоне, «плывут» относительно нарисованного клина, пока танк
(а с ним камера) едет. Сильнее всего это видно у верха рампы.

### Причина (проверена по коду)

1. **Осколки проецируются на целый уровень.** Осколки (`src/client/parts/effects/shot/ImpactEffect.js`, лежат
   8–15 с) — дети `ShotEffectController` (`src/client/parts/effects/shot/ShotEffectController.js`): метод
   `_impactHost()` возвращает сам контроллер, если попадание не в стену. В `onRender` контроллер проецирует себя
   вместе со всеми детьми на высоту уровня конца луча:
   `applyParallax(this, camera, this.endLevel * parallaxConfig.shear, 1)` (≈ стр. 132). `endLevel` — целое
   число из строки трассера (`W1_END_LEVEL`).
2. **Клин рампы проецируется повершинно.** `buildRampMeshes` в `src/client/parts/map/extrusion.js` (≈ стр. 516)
   даёт каждой вершине высоту `k = lerp(from, to, progress) · shear`. Точка на середине склона стоит на
   полуровня выше пола, у верха — почти на целый уровень.
3. **Итог.** Осколки лежат на «полу под клином». Сдвиг проекции у них `endLevel · shear`, у склона под ними —
   `h · shear`. При движении центра камеры разница `(p − cam) · (h − endLevel) · shear` меняется, и осколки
   ползут по нарисованной рампе.
4. **Ошибка старая.** Проекция по `endLevel` появилась в d911e60 (2026-09-05). Этап 14.5 прошлой задачи только
   осветил склон, и дефект стал заметен.

### Как выстрел попадает «в рампу»

Хост не знает склона. Луч уровня 0, пущенный вверх по рампе, упирается в её «неправильный торец»: это
коллайдер-страж на верхней кромке прогона, группа нижнего уровня прогона (движок `vimp-engine-core`,
`map::ramp_guards`; толщина стража — 0.1 тайла, центр — на `run.max` при `sign > 0`). Поэтому `end_level = 0`
(`core/src/tanks.rs`, `process_hitscan`; клиентский предиктор — `core/src/client/shot.rs`), а точка удара
лежит у верха клина.

Осколки летят назад, вниз по склону: направление −луч, разброс 60°, начальная скорость до 300 ед/с,
сопротивление 13, то есть пролёт до ≈ 23 мировых единиц. На карте `downtown` клетка —
`step 32 × scale 0.4 = 12.8` ед., рампа моста — 3 клетки на уровень (≈ 38 ед.). В одном облаке осколков
разница высот склона доходит до ≈ 0.6 уровня. **Поэтому одной поправки на точку удара мало: высоту склона
нужно брать для каждого осколка в его точке.**

Тот же дефект у попадания в танк на рампе: `end_level` — уровень сегмента луча, на котором задет коллайдер
(с земли — 0), а танк нарисован на своём непрерывном `z`.

### Что уже есть и переиспользуется

- Сервис `rampRuns` (`src/client/index.js`, `hooks.services`): `forLevel(level)` отдаёт прогоны рамп ядра
  (`core.ramp_runs()`, JSON). Формат прогона — `{ axis, sign, from, to, min, max, crossMin, crossMax, block,
railMin, railMax }`, координаты МИРОВЫЕ: `axis` 0 = x, 1 = y; `sign` +1 — подъём в сторону роста координаты;
  `min/max` — границы вдоль оси; `crossMin/crossMax` — поперёк. Разбор кешируется по `core.map_generation()`.
- Формула высоты склона `lerp(from, to, progress)`, где `progress = sign > 0 ? t : 1 − t`, а
  `t = (along − min)/(max − min)`, — та же у движка (`MapLevels::ramp_at`, z танка), у вершин клина
  (`buildRampMeshes`) и у освещения (`lightMath.rampHeight` — на полосах в КЛЕТКАХ, для прогонов в мировых
  единицах не подходит).
- Проекция 2.5D живёт только в `src/client/parallax.js`: `offsetPoint(x, y, camera, k)` и
  `applyParallax(target, camera, k, baseScale)`. Формула переноса ребёнка из проекции контейнера в проекцию
  другой высоты сейчас написана вручную в `ShotEffectController._placeFlash`:
  `q = cam + (p − cam)·(1 + k_s)/(1 + k_e)`. Её надо вынести в `parallax.js` и использовать дважды.
- `cameraCenter(parent, renderer)` (`src/client/camera.js`) → `{ x, y, scaleX, scaleY }` или `null`.
  `null` — кадр без проекции, трансформ контроллера тогда единичный.

### Порядок кадра (почему решение устойчиво)

`BaseEffect.run()` вешает `_update` на `Ticker.shared` (тик). `onRender` контроллера вызывается при рендере до
пересчёта трансформов (PixiJS v8, на этом уже держится `applyParallax` в `onRender`). Новый `project`
пересчитывает позиции осколков из их состояния (`pData`), а не из текущего спрайта. Поэтому он идемпотентен:
не важно, что было раньше в кадре, тик или рендер, — последним перед отрисовкой всегда работает `onRender`.

---

## Этап 1. `rampSurfaceAt` — высота поверхности рампы в точке ✅ выполнен

**Новый файл** `src/client/rampSurface.js`:

```js
// Высота поверхности рампы в мировой точке, в уровнях.
//
// `runs` — прогоны рамп ядра в МИРОВЫХ единицах (`core.ramp_runs()`, сервис
// `rampRuns`): `{ axis, sign, from, to, min, max, crossMin, crossMax }`.
// Высота — `lerp(from, to, progress)`, прогресс — доля пути вдоль оси от
// подножия. Это та же формула, по которой ядро ведёт z танка
// (`MapLevels::ramp_at` движка) и строятся вершины клина
// (`extrusion.js`, `buildRampMeshes`); близнец освещения на полосах в
// клетках — `lightMath.rampHeight`.
//
// Прогон учитывается, только если `level` лежит между его подножием и
// вершиной: пол террасы ПОД горкой уровнем выше рампой не накрыт.
// null — точка не на рампе этого уровня
export function rampSurfaceAt(runs, level, x, y) {
  if (!Array.isArray(runs)) {
    return null;
  }

  for (const run of runs) {
    const low = Math.min(run.from, run.to);
    const high = Math.max(run.from, run.to);

    if (level < low || level > high) {
      continue;
    }

    const along = run.axis === 0 ? x : y;
    const cross = run.axis === 0 ? y : x;

    if (along < run.min || along > run.max || cross < run.crossMin || cross > run.crossMax) {
      continue;
    }

    const span = run.max - run.min;
    const t = span > 0 ? (along - run.min) / span : 0;
    const progress = run.sign > 0 ? t : 1 - t;

    return run.from + (run.to - run.from) * progress;
  }

  return null;
}
```

Границы включительно: на верхней кромке высота равна `to`, то есть высоте плиты, на подножии — `from`.
Стык непрерывен.

**Тест** `tests/client/rampSurface.test.js` (новый; `describe`/`it` на русском, как в соседних тестах):

- подъём по `+x` (`{ axis: 0, sign: 1, from: 0, to: 1, min: 100, max: 140, crossMin: 0, crossMax: 20 }`):
  `x = 100 → 0`, `x = 120 → 0.5`, `x = 140 → 1`;
- подъём по `−y` (`axis: 1, sign: −1`, `min: 0, max: 40`): `y = 40 → 0` (подножие на `max`), `y = 0 → 1`,
  `y = 10 → 0.75`;
- нисходящая рампа (`from: 1, to: 0, sign: 1`): на `min` → 1, на `max` → 0, для `level` 0 и 1;
- точка вне прогона вдоль оси и поперёк → `null`;
- фильтр уровня: прогон `1 → 2`, `level 0 → null` (терраса под горкой), `level 1` и `level 2` → число;
- не массив (`undefined`) → `null`.

---

## Этап 2. Сервис `rampRuns.heightAt` и проводка зависимости ✅ выполнен

**`src/client/index.js`**:

1. Импорт: `import { rampSurfaceAt } from './rampSurface.js';`.
2. В `services(core)` вынести чтение кеша прогонов из `forLevel` в локальную функцию (рядом с
   `runsCache`/`runsGeneration`):
   ```js
   // все прогоны карты: разбор держится до смены карты (поколение ядра)
   const allRuns = () => {
     const generation = core.map_generation();

     if (generation !== runsGeneration) {
       runsGeneration = generation;
       runsCache = JSON.parse(core.ramp_runs());
     }

     return runsCache;
   };
   ```
   Длинный комментарий о кешировании, который сейчас стоит над `forLevel`, сохранить (над `allRuns` или над
   `forLevel`, по смыслу).
3. `forLevel(level)` → `return allRuns().filter(run => run.from === level);`. Поведение прежнее.
4. Новый метод рядом:
   ```js
   // высота поверхности рампы под мировой точкой, в уровнях; null — точка
   // не на рампе уровня `level` (src/client/rampSurface.js). По ней эффект
   // выстрела кладёт осколки на склон
   heightAt(level, x, y) {
     return rampSurfaceAt(allRuns(), level, x, y);
   },
   ```
5. В комментарии над `services(core)` («rampRuns — прогоны рамп из ядра…») дописать, что по ним же эффект
   выстрела кладёт осколки на склон.

**`src/config/client.js`** (`componentDependencies`, ≈ стр. 297–300): `rampRuns: ['Map']` →
`rampRuns: ['Map', 'ShotEffect']`. В комментарий добавить: «…и эффект выстрела кладёт осколки попадания на
склон (`heightAt`)».

**Тесты:**

- `tests/config/client.test.js`, тест «rampRuns объявлен и в componentDependencies, и в serviceNames»: ожидание
  `['Map', 'ShotEffect']`.
- `tests/client/tanksClientPlugin.test.js`: новый `describe('ClientPlugin: сервис rampRuns')` по образцу
  `describe('ClientPlugin: сервис surfaces')`. Фейковое ядро:
  `{ 'map_generation': vi.fn(() => 1), 'ramp_runs': vi.fn(() => JSON.stringify(runs)) }`, где
  `runs = [{ axis: 0, sign: 1, from: 0, to: 1, min: 64, max: 128, crossMin: 0, crossMax: 64, block: 0,
railMin: 76.8, railMax: 128 }]`.
  - `heightAt(0, 96, 32) → 0.5`, `heightAt(0, 40, 32) → null`, `heightAt(2, 96, 32) → null`;
  - `forLevel(0)` и `heightAt` делят один разбор: после обоих вызовов `ramp_runs` вызван один раз; после
    `core.map_generation.mockReturnValue(2)` и нового `heightAt` — два раза.

---

## Этап 3. `reproject` в `parallax.js`, вспышка у дула через него ✅ выполнен

**`src/client/parallax.js`** — добавить третью функцию:

```js
// Перенос точки внутри контейнера, который уже стоит в проекции `kHost`
// (`applyParallax`): куда поставить ребёнка из мировой точки `(x, y)`,
// чтобы после трансформа контейнера он лёг в проекцию СВОЕЙ высоты `k`.
// Из cam + (q − cam)·(1 + kHost) = cam + (p − cam)·(1 + k):
//   q = cam + (p − cam)·(1 + k)/(1 + kHost),
// масштаб ребёнка — то же отношение. Без камеры (кадр без трансформа
// сцены: `applyParallax` сбросил контейнер в единичный) — исходная точка
// и масштаб 1
export function reproject(x, y, camera, kHost, k) {
  if (!camera) {
    return { x, y, scale: 1 };
  }

  const scale = (1 + (k || 0)) / (1 + (kHost || 0));

  return {
    x: camera.x + (x - camera.x) * scale,
    y: camera.y + (y - camera.y) * scale,
    scale,
  };
}
```

В шапке файла фраза «…зовут только эти две функции» станет неверной. Переписать: потребители зовут
`offsetPoint`/`applyParallax`, а перенос ребёнка внутри контейнера в проекцию другой высоты (вспышка у дула
выстрела с моста, осколки на склоне рампы) делает `reproject`.

**`ShotEffectController._placeFlash`** перевести на `reproject`. Импорт:
`import { applyParallax, reproject } from '../../../parallax.js';`. Тело после проверки
`if (!this.flash || this.flash.destroyed) return;`:

```js
const { shear } = parallaxConfig;
const point = reproject(
  this.startPositionX,
  this.startPositionY,
  camera,
  this.endLevel * shear,
  this.startLevel * shear,
);

this.flash.position.set(point.x, point.y);
this.flash.scale.set(point.scale);
```

Отдельная ветка `if (!camera)` больше не нужна: её делает `reproject`. Смысл её комментария («кадр без центра
камеры: вспышка ровно в точке вылета, а не в проекции прошлого кадра») сохранить одной-двумя строками над
вызовом. Комментарий метода с формулой заменить ссылкой на `reproject`. Поведение не меняется: его страхуют
тесты `describe('ShotEffectController: вспышка у дула')`, в том числе «кадр без центра камеры».

**Тест** `tests/client/parallax.test.js`: новый `describe('parallax: reproject')`.

- `kHost === k` → исходная точка, `scale 1`.
- `kHost = 0` → точка совпадает с `offsetPoint(x, y, camera, k)`, `scale = 1 + k`.
- Композиция (главный тест). `applyParallax(target, camera, kHost)`, ребёнок в `q = reproject(p, camera,
kHost, k)`, затем `worldOf(target, q.x, q.y)` (хелпер уже есть в файле) даёт `offsetPoint(p, camera, k)`.
  Проверить при `kHost = 0.22`, `k = 0.5 · 0.22` и при `k < kHost`.
- `camera = null` → исходная точка, `scale 1`.

---

## Этап 4. `ImpactEffect`: высота на каждый осколок и `project` ✅ выполнен

**`src/client/parts/effects/shot/ImpactEffect.js`**:

1. Импорт: `import { reproject } from '../../../parallax.js';`.
2. Конструктор получает седьмой необязательный аргумент:
   `constructor(x, y, impactDirectionX, impactDirectionY, onComplete, assets, { surfaceK = null } = {})`.
   До `_createParticles()` сохранить:
   ```js
   // 2.5D: коэффициент проекции поверхности под мировой точкой (склон
   // рампы) или null — пол контейнера-хозяина. Даёт контроллер выстрела
   this._surfaceK = typeof surfaceK === 'function' ? surfaceK : null;
   ```
3. Хелпер:
   ```js
   // коэффициент проекции поверхности под осколком; null — пол хозяина
   _kAt(pData) {
     return this._surfaceK
       ? this._surfaceK(this.x + pData.x, this.y + pData.y)
       : null;
   }
   ```
   Мировая точка осколка — `this.x + pData.x`, `this.y + pData.y`: `pData.x/y` отсчитываются от точки удара,
   позиция эффекта — сама точка удара.
4. `_createParticles`: в `particleData` добавить поле `k: null` и сразу после создания объекта присвоить
   `particleData.k = this._kAt(particleData);` (точка удара).
5. `_update`, ветка `if (pData.isMoving)`: сразу после `pData.y += pData.vy * deltaSeconds;` добавить
   ```js
   // высота поверхности под осколком меняется, только пока он летит
   pData.k = this._kAt(pData);
   ```
   У лежащего осколка `k` кешируется, и `surfaceK` больше не зовётся. Остальной `_update` не менять: он
   по-прежнему ставит сырую позицию и масштаб, а `project` их переопределяет.
6. Новый публичный метод:
   ```js
   // 2.5D: осколок на склоне рампы лежит на склоне. Контейнер-хозяин уже в
   // проекции `kHost` (контроллер — уровень конца луча), осколок с высотой
   // поверхности `pData.k` переносится внутри неё в проекцию своей высоты
   // (`reproject`). Считается из `pData`, а не из спрайта: вызов
   // идемпотентен, порядок с тиком `_update` не важен. Без `surfaceK` —
   // ничего не делает
   project(camera, kHost) {
     if (!this._surfaceK) {
       return;
     }

     for (const pData of this.particlesData) {
       if (!pData.active) {
         continue;
       }

       const point = reproject(
         this.x + pData.x,
         this.y + pData.y,
         camera,
         kHost,
         pData.k ?? kHost,
       );

       pData.sprite.position.set(point.x - this.x, point.y - this.y);
       pData.sprite.scale.set(
         (pData.size / this._textureContentSize) * point.scale,
       );
     }
   }
   ```
   При `pData.k === null` получается `k = kHost`: `reproject` отдаёт сырую точку и `scale 1`, ровно прежнее
   поведение.
7. В комментарий класса (шапка конструктора) добавить строку: высоту поверхности под осколками (склон рампы)
   даёт контроллер через `surfaceK`, а проекцию — `project`.

**Тест** `tests/client/parts/effects/ImpactEffect.test.js` (новый). Ассеты:
`{ impactParticleTexture: { texture: Texture.EMPTY, contentSize: 8 } }`. Эффект в `(100, 0)`,
`onComplete = () => {}`. `run()` не звать (он вешает `Ticker.shared`), вместо него — `_update(0)`. Осколок
фиксировать напрямую: `const p = effect.particlesData[0]; p.x = −20; p.y = 0; p.vx = 0; p.vy = 0;
p.isMoving = true; effect._update(0);`. Нулевая скорость — осколок встаёт в этом тике, и `k` пересчитывается
для мировой точки `(80, 0)`.

- **Проекция склона.** `surfaceK = vi.fn(x => (x >= 50 && x <= 150 ? ((x − 50) / 100) * 0.22 : null))`,
  `effect.project({ x: 0, y: 0 }, 0)`. Ожидания: `effect.x + p.sprite.x ≈ offsetPoint(80, 0, cam, 0.3 · 0.22).x`,
  `p.sprite.scale.x ≈ (p.size / 8) · (1 + 0.3 · 0.22)`.
- **Хозяин с ненулевой проекцией.** `project(cam, 0.22)`: мировая точка после трансформа хозяина
  (`applyParallax` на пустом `Container` с `kHost = 0.22`; позиция ребёнка — `effect.x + sprite.x`) равна
  `offsetPoint(80, 0, cam, k)`.
- **Кеш.** После остановки ещё два `_update(16)`: число вызовов `surfaceK` не растёт.
- **Вне рампы.** `surfaceK → null`: после `project` `p.sprite.x === p.x`, масштаб без множителя.
- **Без `surfaceK`.** `project` ничего не меняет.
- **Без камеры.** `project(null, 0.22)`: сырая позиция, масштаб без множителя.

---

## Этап 5. `ShotEffectController`: `surfaceK` и `_placeDebris` ✅ выполнен

**`src/client/parts/effects/shot/ShotEffectController.js`**:

1. Конструктор, после `this._volumes = dependencies.volumes || null;` (≈ стр. 105):
   ```js
   // прогоны рамп (сервис `rampRuns`): осколки на склоне лежат на склоне,
   // а не на полу уровня конца луча (`_surfaceK`, `_placeDebris`)
   this._rampRuns = dependencies.rampRuns || null;
   ```
2. Новый метод (рядом с `_impactHost`):
   ```js
   // Коэффициент проекции поверхности под мировой точкой для осколков: на
   // склоне рампы — высота склона (`rampRuns.heightAt`, та же, что у вершин
   // клина), иначе null — пол уровня конца. Хост склона не знает: луч с
   // земли вверх по рампе упирается в стража её верхнего торца с уровнем
   // конца 0, а осколки ложатся на склон. Искрам в грани стены не нужен —
   // у них свой слой на высоте ствола (`_impactHost`)
   _surfaceK() {
     const ramps = this._rampRuns;

     if (this._wall || typeof ramps?.heightAt !== 'function') {
       return null;
     }

     const level = this.endLevel;
     const { shear } = parallaxConfig;

     return (x, y) => {
       const height = ramps.heightAt(level, x, y);

       return height === null ? null : height * shear;
     };
   }
   ```
3. `_onTracerComplete`: в `new ImpactEffect(…, this._assets)` добавить седьмой аргумент
   `{ surfaceK: this._surfaceK() }`. `this._wall` к этому моменту уже посчитан в `run()` (`_wallEnd`).
4. Новый метод:
   ```js
   // Осколки попадания в самом контроллере (не в стену) лежат на
   // поверхности под собой: на склоне рампы — в его проекции, а не пола
   // уровня конца (`ImpactEffect.project`)
   _placeDebris(camera) {
     const impact = this.impact;

     if (!impact || impact.destroyed || impact.parent !== this) {
       return;
     }

     impact.project(camera, this.endLevel * parallaxConfig.shear);
   }
   ```
5. `onRender` (≈ стр. 143–145): между `this._placeFlash(camera);` и `this._placeImpact(camera);` вставить
   `this._placeDebris(camera);`. В комментарий «проекция высоты: трассер и осколки на мосту стоят на мосту…»
   дописать: «…а осколки на склоне рампы — на склоне (`_placeDebris`)».

**Тест** `tests/client/parts/effects/ShotEffectController.test.js` — новый
`describe('ShotEffectController: осколки на склоне рампы')`. Хелперы файла: `makeController`, `finishTracer`;
импортировать `offsetPoint` из `src/client/parallax.js`. Строка трассера
`[10, 40, 120, 40, 0, 0, true, 1, 0, 0]` — выстрел с земли, попадание у верха рампы. Рампа — подъём 0 → 1
вдоль `+x` на `[64, 128]`: `rampRuns = { heightAt: vi.fn((level, x) => (x >= 64 && x <= 128 ? (x − 64) / 64 : null)) }`.
`renderer = { screen: { width: 800, height: 600 } }`. Центр камеры `(camX, 40)` задаётся сдвигом сцены, как в
`wallShot`: `controller.parent.position.set(400 − camX, 300 − 40)`. Осколок фиксировать как в этапе 4 (через
`controller.impact.particlesData[i]`, `x` относительно точки удара 120, затем `impact._update(0)`).

- **Осколок на склоне — в проекции склона.** `camX = 0`, осколок в мировой `(96, 40)`, затем
  `controller.onRender()`. `endLevel 0`, поэтому трансформ контроллера единичный, и
  `impact.x + sprite.x ≈ offsetPoint(96, 40, { x: 0, y: 40 }, 0.5 · parallax.shear).x`.
  `rampRuns.heightAt` вызван с `(0, 96, 40)`. По правилу `CLAUDE.md` проверить и регистрацию колбэка:
  `expect(typeof controller._onRender).toBe('function')`.
- **Два осколка на разной высоте** (`x = 72` и `x = 120`) сдвинуты по-разному, и каждый совпадает со своим
  `offsetPoint`.
- **Уровень конца 1** (строка с `endLevel = 1`, осколок на склоне). Мировая точка после трансформа контроллера,
  то есть `(impact.x + sprite.x) · controller.scale.x + controller.position.x`, равна `offsetPoint` с высотой
  склона. `heightAt` вызван с уровнем 1.
- **Вне рампы** (осколок в `x = 40`) и **без сервиса `rampRuns`** — сырая позиция, как раньше.
- **Попадание в стену.** Строка и `volumes` как в `describe('… попадание в грань стены')`, плюс шпион
  `rampRuns`. Осколки в слое `shot-impact` (`impact.parent !== controller`), `heightAt` не вызывался.

---

## Этап 6. Документация en/ru и CHANGELOG ✅ выполнен

Правило `CLAUDE.md`: функциональная правка обновляет парные страницы `docs/en/` и `docs/ru/` в той же правке.

1. **`docs/en/architecture.md`**: после абзаца о попадании в стену (он кончается фразой «…its side (over or
   under the occluder) is re-picked every frame.», искать `grep -n "re-picked every frame" docs/en/architecture.md`)
   вставить новый абзац:

   > Debris of a hit that lands on a ramp lies on the drawn slope. The host knows no slope: a ground ray up a
   > ramp stops at the guard of its top end with end level `0`, and a tank on a ramp is hit on the level of
   > the ray's segment while it is drawn at its own `z`. The controller's end-level projection therefore left
   > the debris on the floor under the wedge, sliding across it as the camera moved. `ImpactEffect` now takes
   > `surfaceK(x, y)` from the controller: the projection of the surface under a world point, by
   > `rampRuns.heightAt(level, x, y)` (`src/client/rampSurface.js`). It picks the run under the point whose
   > foot and top enclose the level and returns `lerp(from, to, progress)`, the same height as the wedge's
   > vertices and the core's tank `z`; off a ramp it returns `null`. Every frame the controller's `onRender`
   > calls `ImpactEffect.project`, which moves each piece inside the controller's projection into the
   > projection of its own point (`reproject`, `src/client/parallax.js`, the same move as the muzzle flash of a
   > shot from a bridge). The height is re-read only while a piece flies. Off a ramp, and for the sparks of a
   > wall hit, nothing changes.

   **`docs/ru/architecture.md`**: после абзаца, который кончается «…его сторона (над перекрывателем или под ним)
   пересчитывается каждый кадр.», вставить:

   > Осколки попадания на склоне рампы лежат на нарисованном склоне. Хост склона не знает. Луч с земли вверх по
   > рампе упирается в стража её верхнего торца с уровнем конца `0`. Танк на рампе поражается на уровне
   > сегмента луча, а нарисован на своём `z`. Поэтому проекция контроллера по уровню конца оставляла осколки на
   > полу под клином, и они ползли по нему при движении камеры. Теперь `ImpactEffect` получает от контроллера
   > `surfaceK(x, y)` — проекцию поверхности под мировой точкой. Её даёт `rampRuns.heightAt(level, x, y)`
   > (`src/client/rampSurface.js`): берётся прогон под точкой, у которого подножие и вершина охватывают уровень,
   > а высота — `lerp(from, to, progress)`, та же, что у вершин клина и у `z` танка в ядре. Вне рампы
   > результат `null`. Каждый кадр `onRender` контроллера вызывает `ImpactEffect.project`: он переносит каждый
   > осколок внутри проекции контроллера в проекцию его собственной точки (`reproject`,
   > `src/client/parallax.js`; так же переносится вспышка у дула при выстреле с моста). Высота перечитывается,
   > только пока осколок летит. Вне рампы и у искр попадания в стену ничего не меняется.

2. **Абзац о `levelView.camera()` → `null`** (en: `grep -n "carry on: \`offsetPoint\`" docs/en/architecture.md`;
ru: `grep -n "работать дальше: так делают" docs/ru/architecture.md`): список «`offsetPoint`and`applyParallax`» → «`offsetPoint`, `applyParallax`and`reproject`» (ru: «`offsetPoint`, `applyParallax`и`reproject`»).

3. **`docs/en/configuration.md`** и **`docs/ru/configuration.md`**, раздел `componentDependencies`:
   - в списке `` `rampRuns` → Map; `` → `` `rampRuns` → Map, ShotEffect; ``;
   - в предложении о `rampRuns` после описания `forLevel(level)` добавить en: «`heightAt(level, x, y)` gives
     the height of the ramp surface under a world point, in levels (`null` off a ramp of that level): the shot
     effect lays its debris on the slope by it.» и ru: «`heightAt(level, x, y)` — высота поверхности рампы
     под мировой точкой в уровнях (`null` — не рампа этого уровня): по ней эффект выстрела кладёт осколки на
     склон.».

4. **`CHANGELOG.md`**, под `## [Unreleased]` (сейчас пустой) создать раздел:
   ```markdown
   ### Fixed

   - Hit debris that lands on a ramp's slope lies on the drawn slope instead of
     sliding across it as the camera moves.
   ```

`CLAUDE.md` проекта не меняется: зависимостей и команд не добавилось.

---

## Этап 7. Итоговая проверка ✅ выполнен

```bash
npx eslint .
npm test -- --silent
npm run build
```

Ядро (`core/`) не меняется, поэтому `npm run core:test` и `npm run sim:scenarios` не нужны. Все тесты должны
быть зелёными. Если падает старый тест вспышки у дула, ошибка в переносе `_placeFlash` на `reproject` (этап 3):
формула обязана совпасть бит в бит.

**Вручную** (`npm run dev`, карта `downtown`, днём и ночью):

1. С земли выстрелить вверх по рампе моста (тайлы `RAMP_S`, `bridgeRampNorth` в `src/data/maps/downtown.js`) и
   по рампе `RAMP_E` (эстакада, трамплин). Объехать рампу: осколки у верха лежат на склоне и не ползут по нему.
2. Выстрелить в танк на рампе: осколки на склоне не плывут.
3. Попадание в пол рядом с рампой, в стену (искры в грани), в ящик — как раньше.
4. Выстрел с моста вниз: вспышка у дула на месте (регресс `_placeFlash`).

---

## Риски и решения

- **Порядок тика и рендера.** `project` считает из `pData`, а не из спрайта, поэтому порядок тика и `onRender`
  значения не имеет. Не «оптимизировать» его в инкрементальный сдвиг спрайта.
- **Цена.** `heightAt` на каждый ЛЕТЯЩИЙ осколок за тик: вызов `core.map_generation()` через WASM и линейный
  обход прогонов (их десятки). Осколков 2–4 на попадание, летят ≈ 0.5 с. Это дёшево. У лежащего осколка
  высота кешируется.
- **Фильтр уровня** `low ≤ level ≤ high` обязателен. Без него осколок на полу террасы под горкой уровнем выше
  «взлетел» бы на её склон.

## За рамками

- **Конец трассера** на рампе рисуется на `endLevel`. Он живёт 45–80 мс, и у него модель высоты ствола, а не
  поверхности.
- **Следы гусениц** (`src/client/parts/tracks/Tracks.js`, `_updateLayers`) проецируются на целый уровень,
  поэтому на склоне, вероятно, тот же класс ошибки. Не проверено, это отдельная задача.
- **Осколок, слетевший с поднятого борта рампы или перелетевший её верхний торец**, сразу проецируется на пол
  уровня конца, без падения. Разлёт мал, а осколки летят назад от стража, вниз по склону. Это допустимо.
