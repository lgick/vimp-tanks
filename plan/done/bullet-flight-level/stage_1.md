# Этап 1. Осколки попадания в стену и в грань насыпи падают с высоты ствола на пол ✅ выполнен

Контекст — `plan/bullet-flight-level/README.md`, «Требование пользователя», проблема 2. Этап от остальных не
зависит.

## Цель

Осколки (`ImpactEffect`) попадания в стену или в грань насыпи рампы рождаются на высоте ствола (там же, где
нарисован конец трассера на грани). За `fallDuration` = 250 мс они падают на поверхность под собой: на пол уровня
конца или на склон рампы. Отдельный слой `shot-impact` убирается, осколки всегда живут в самом контроллере
выстрела. Сторона грани пересчитывается каждый кадр, как это делал слой.

## Как устроено сейчас (проверено по коду)

`src/client/parts/effects/shot/ShotEffectController.js`:

- `_wallEnd(dx, dy, dist)` находит задетую грань: `this._wall = this._wallAt(nx, ny)` → `{ face, volume }` или
  `null`.
  - Если грань смотрит на камеру (`faceIsFront`), конец трассера переносится на высоту ствола
    (`reproject(…, (endLevel + tracerConfig.height) · shear)`), а `this.zIndex = levelZ(WALL_HIT_BASE_Z, endLevel)` —
    контроллер встаёт над перекрывателем.
  - Если грань отвёрнута, трассер обрывается на силуэте, `zIndex` остаётся `levelZ(SHOT_BASE_Z, endLevel)`.
- `_onTracerComplete()` создаёт `new ImpactEffect(…, { surfaceK: this._debrisSurface() })` и кладёт его в
  `this._impactHost()`.
- `_impactHost()` для стены создаёт `Container` с `label = 'shot-impact'` на сцене (`this._impactLayer`), иначе
  возвращает `this`.
- `_placeImpact(camera)` (из `onRender`) каждый кадр проецирует слой на `(endLevel + tracer.height)·shear` и ставит
  его `zIndex` по стороне грани: `WALL_HIT_BASE_Z`, если грань к камере, иначе `SHOT_BASE_Z`.
- `_debrisSurface()` у стены возвращает `null`, иначе функцию `(x, y) → k` по `rampRuns.heightAt`.
- `_placeDebris(camera)` вызывает `impact.project(camera, endLevel · shear)`, только если `impact.parent === this`.
- В `destroy` есть блок уборки `_impactLayer`.

`src/client/parts/effects/shot/ImpactEffect.js`:

- Конструктор — `(x, y, dirX, dirY, onComplete, assets, { surfaceK = null } = {})`. У осколка есть
  `pData: { x, y, vx, vy, size, age, lifetime, isMoving, k, sprite, … }`, `pData.k = this._kAt(pData)`.
- `_update(deltaMs)` двигает осколки, пересчитывает `pData.k`, пока осколок летит, и ставит
  `sprite.position = (pData.x, pData.y)` и масштаб.
- `project(camera, kHost)` при `!this._surfaceK` сразу выходит. Иначе делает
  `reproject(this.x + pData.x, this.y + pData.y, camera, kHost, pData.k ?? kHost)` → позиция и масштаб спрайта.

## Шаги

### 1.1. `ImpactEffect.js`

1. В опции конструктора добавить `startK`: `{ surfaceK = null, startK = null } = {}`. Сохранить:
   ```js
   // 2.5D: коэффициент проекции высоты, на которой осколки рождаются
   // (попадание в стену — высота ствола); null — сразу на поверхности.
   // С неё осколок падает на поверхность за `fallDuration`
   this._startK = typeof startK === 'number' ? startK : null;
   ```
   Присваивание — до `this._createParticles()`.
2. В `this.config` добавить `fallDuration: 250` с комментарием «мс: падение осколка с высоты рождения на
   поверхность».
3. В `particleData` добавить поле `lift: 1` — доля высоты рождения, убывает от 1 до 0.
4. В `_update`, сразу после `pData.age += deltaMs;`:
   ```js
   // падение с высоты рождения: с ускорением, как под тяжестью
   const fall = Math.min(pData.age / this.config.fallDuration, 1);

   pData.lift = 1 - fall * fall;
   ```
5. Новый метод рядом с `project`:
   ```js
   // Падает ли ещё хоть один осколок с высоты рождения
   isFalling() {
     return (
       this._startK !== null &&
       this.particlesData.some(pData => pData.active && pData.lift > 0)
     );
   }
   ```
6. `project(camera, kHost)`:
   - первая строка: `if (!this._surfaceK && this._startK === null) { return; }`;
   - высота осколка:
     ```js
     const surface = pData.k ?? kHost;
     const k = this._startK === null ? surface : surface + (this._startK - surface) * pData.lift;
     ```
     и дальше `reproject(this.x + pData.x, this.y + pData.y, camera, kHost, k)`. Позиция и масштаб — как было.
7. Комментарии в шапке класса и над `project` дополнить: «осколки попадания в стену рождаются на высоте `startK`
   и за `fallDuration` падают на поверхность».

### 1.2. `ShotEffectController.js`

1. Удалить `_impactHost()`, `_placeImpact(camera)`, поле `this._impactLayer` вместе с комментарием, вызов
   `this._placeImpact(camera)` в `onRender` и блок уборки `_impactLayer` в `destroy`.
2. `_onTracerComplete`: вместо `this._impactHost().addChild(this.impact)` написать
   `this.addChild(this.impact)`. Опции эффекта:
   `{ surfaceK: this._debrisSurface(), startK: this._debrisStartK() }`.
3. Новый метод рядом с `_debrisSurface`:
   ```js
   // Коэффициент проекции высоты, на которой рождаются осколки: у
   // попадания в стену или грань насыпи — высота ствола над полом уровня
   // конца, там же конец трассера на грани (`_wallEnd`); иначе null —
   // сразу на поверхности
   _debrisStartK() {
     return this._wall
       ? (this.endLevel + tracerConfig.height) * parallaxConfig.shear
       : null;
   }
   ```
4. `_debrisSurface()`: убрать `this._wall ||` из первого условия. У подножия стены осколки тоже ложатся на
   поверхность, на склоне — на склон. В комментарии метода последнее предложение («Грани насыпи и стене не
   нужен…») заменить на «У стены и грани насыпи осколки падают на эту поверхность с высоты ствола
   (`_debrisStartK`)».
5. Комментарий `_placeDebris`: «Осколки попадания лежат на поверхности под собой…» — слова «(не в стену)» убрать.
6. **Сторона грани — каждый кадр.** Новый метод и его вызов в `onRender` сразу после `this._placeDebris(camera);`:
   ```js
   // Осколки попадания в стену: пока они падают перед видимой гранью,
   // контроллер над перекрывателем (иначе грань закрыла бы их). Лежащие
   // на полу и за отвёрнутой гранью — под ним, под крышей, как всё на
   // полу. Сторона — каждый кадр: осколки лежат 6–15 с, камера за это
   // время уходит далеко
   _placeImpactZ(camera) {
     const impact = this.impact;

     if (!this._wall || !impact || impact.destroyed) {
       return;
     }

     const front = Boolean(
       camera &&
         faceIsFront(this._wall.face, this.endPositionX, this.endPositionY, camera),
     );

     this.zIndex = levelZ(
       front && impact.isFalling() ? WALL_HIT_BASE_Z : SHOT_BASE_Z,
       this.endLevel,
     );
   }
   ```
   Во время полёта трассера `zIndex` по-прежнему ставит `_wallEnd`: `this.impact` появляется только после
   трассера.
7. Комментарий у `WALL_HIT_BASE_Z` («иначе грань закрывает искры») → «…закрывает конец трассера и падающие
   осколки». Слово «искры» в комментариях контроллера заменить на «осколки» там, где речь об `ImpactEffect`.
8. Проверить: `grep -n "shot-impact\|_impactHost\|_placeImpact\b\|_impactLayer" src/client` — пусто.

### 1.3. Тесты

1. `tests/client/parts/effects/ImpactEffect.test.js`, новый блок `describe('ImpactEffect: падение с высоты
рождения')`. Хелперы файла — `assets`, `camera`, `SHEAR`, `makeEffect`, `offsetPoint`, `slopeK`. `makeEffect`
   ставит осколки в мировую `(80, 0)` и вызывает `_update(0)`.
   - `makeEffect({ startK: 0.5 * SHEAR })`, `project(camera, 0)`: осколок в `offsetPoint(80, 0, camera, 0.5 * SHEAR)`,
     масштаб `(size / CONTENT_SIZE) · (1 + 0.5·SHEAR)`, `effect.isFalling() === true`.
   - после `effect._update(125)` (середина: `lift = 1 − 0.25`) → `k = 0.5·SHEAR·0.75`;
   - после `effect._update(250)` → `lift = 0`, осколок в сырой позиции (`k = kHost = 0`),
     `isFalling() === false`. Для этого теста осколки не должны улетать: `makeEffect` обнуляет скорости, и они
     стоят;
   - `makeEffect({ surfaceK: slopeK, startK: SHEAR })`, `_update(250)`, `project(camera, 0)` → проекция склона в
     `x = 80` (`k = 0.3·SHEAR`);
   - существующий тест «без surfaceK project ничего не меняет» остаётся без изменений.
2. `tests/client/parts/effects/ShotEffectController.test.js`:
   - тест «искры — в своём слое на высоте ствола, сторона грани — каждый кадр» (≈ 575) заменить тестом «осколки
     в контроллере падают с высоты ствола, сторона грани — каждый кадр»:
     - после `run()` и `finishTracer(controller)`: `controller.impact.parent === controller`,
       `controller.impact._startK ≈ tracer.height * parallax.shear`, `controller.zIndex === WALL_HIT_Z`
       (падают, грань к камере);
     - `stage.position.x = 400 - 300; controller.onRender();` → `controller.zIndex === SHOT_Z` (камера за стеной);
     - вернуть камеру (`stage.position.x = 400 - 0`), `controller.impact._update(300)`, `controller.onRender()` →
       `SHOT_Z` (осколки уже на полу);
     - `controller.destroy()` → на сцене нет детей с `label === 'shot-impact'`;
   - тест «попадание не в стену — искры в самом контроллере» (≈ 606) переименовать в «…осколки в самом
     контроллере, без высоты рождения» и добавить `expect(controller.impact._startK).toBeNull()`;
   - тест «попадание в стену: осколки в слое shot-impact, склон не спрашивается» (≈ 727) переписать как
     «попадание в стену: осколки в контроллере падают на склон». Ожидания: `impact.parent === controller`,
     `impact._startK` не `null`, `rampRuns.heightAt` вызывался (`_debrisSurface` теперь работает и для стены);
   - тест «грань насыпи к камере: конец на высоте ствола, искры в слое shot-impact» (≈ 795): строку
     `expect(controller.impact.parent.label).toBe('shot-impact')` заменить на
     `expect(controller.impact.parent).toBe(controller)` и
     `expect(controller.impact._startK).toBeCloseTo((0 + tracer.height) * parallax.shear, 9)`. В названии
     «искры в слое shot-impact» заменить на «осколки падают с высоты ствола».
3. Команды: `npx vitest run tests/client`, `npx eslint src tests`.

## Критерий готовности

- `grep -rn "shot-impact\|_impactHost\|_placeImpact\b\|_impactLayer" src tests` — пусто. Документацию правит этап 6.
- `npx vitest run tests/client` зелёный, eslint чистый.
- Этап отмечен «✅ выполнен» здесь и в `README.md`.
