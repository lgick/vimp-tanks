# Этап 4. Клиент: наклон, полёт, просадка на приземлении ✅ выполнен

Требует этап 3 (поля `vz`/`pitch`/`roll` в кадре).

Файлы: `src/client/tilt.js` (новый), `src/client/parts/Tank.js`,
`src/config/render.js`, `src/config/client.js`,
`tests/client/parts/Tank.test.js`, `tests/client/tilt.test.js` (новый).

## 4.1. Чистая математика наклона — `src/client/tilt.js`

Отдельный модуль, потому что формула нужна трём спрайтам танка (корпус,
пушка, остов) и обязана быть тестируемой без PixiJS.

```js
/**
 * Углы квада спрайта, наклонённого по тангажу и крену.
 *
 * Квад лежит в плоскости карты; наклон — поворот этой плоскости вокруг
 * локальных осей корпуса с последующей ортографической проекцией той же
 * формулой высоты, что и весь 2.5D (`src/client/parallax.js`): точка,
 * поднявшаяся на высоту `h`, отъезжает от центра на `h * shear`.
 *
 * @param {object} p
 * @param {number} p.width      ширина спрайта в экранных единицах
 * @param {number} p.height     высота спрайта
 * @param {number} p.anchorX    0..1
 * @param {number} p.anchorY    0..1
 * @param {number} p.rotation   собственный поворот спрайта (пушка), рад
 * @param {number} p.pitch      продольный наклон, рад
 * @param {number} p.roll       поперечный наклон, рад
 * @param {number} p.shear      parallax.shear
 * @returns {number[]} [x0,y0, x1,y1, x2,y2, x3,y3] — левый верх, правый
 *   верх, правый низ, левый низ, в локальных координатах контейнера танка
 */
export function tiltCorners({ width, height, anchorX, anchorY, rotation, pitch, roll, shear })
```

Реализация:

1. Четыре угла в локальных координатах спрайта:
   `u ∈ {-anchorX·width, (1-anchorX)·width}`,
   `v ∈ {-anchorY·height, (1-anchorY)·height}`,
   обход по часовой: `(u0,v0) (u1,v0) (u1,v1) (u0,v1)`.
2. Собственный поворот спрайта (для пушки): повернуть `(u,v)` на
   `rotation`.
3. Наклон. Ось тангажа — поперёк корпуса (локальный X), ось крена — вдоль
   (локальный Y). Точка `(u, v, 0)`:
   - тангаж: `v' = v·cos(pitch)`, `h₁ = -v·sin(pitch)`
     (знак минус: экранный `+v` — это «вниз/назад», а поднимается нос);
   - крен: `u' = u·cos(roll)`, `h₂ = u·sin(roll)`;
   - высота точки `h = h₁ + h₂`, в **экранных** единицах.
4. Проекция высоты: `k = (h / height) · shear` — доля корпуса в высоте,
   переведённая в тот же безразмерный сдвиг, которым живёт весь 2.5D.
   Итог: `x = u'·(1 + k)`, `y = v'·(1 + k) - h·tiltConfig.lift`.

   `lift` (см. 4.2) — насколько поднявшаяся часть корпуса уезжает вверх по
   экрану. Без него наклон читается только сжатием и выглядит как
   «сплющивание».

Функция чистая, без PixiJS, без состояния. Порядок углов —
как требует `PerspectiveMesh.setCorners(x0,y0,x1,y1,x2,y2,x3,y3)`
(левый верх → правый верх → правый низ → левый низ).

## 4.2. Ручки в `src/config/render.js`

Рядом с `shadow` (файл — единственный дом чисел 2.5D):

```js
// наклон корпуса на рампе и в полёте
export const tilt = {
  // включает деформацию корпуса целиком; false — прежний плоский спрайт
  enabled: true,
  // экранный подъём поднявшегося края (в долях его высоты)
  lift: 0.35,
  // плотность сетки PerspectiveMesh по каждой оси
  vertices: 6,
};

// просадка на приземлении
export const landing = {
  // вертикальная скорость касания (уровней/с), дающая полную просадку
  fullImpact: 6,
  // максимальное сжатие корпуса по вертикали (доля)
  squash: 0.22,
  // длительность просадки и возврата, мс
  duration: 260,
  // порог |vz| касания, ниже которого приземление считается мягким:
  // ни просадки, ни пыли, ни звука
  minImpact: 1.5,
};
```

Продублировать оба объекта в `src/config/client.js` в блоке `parts`
рядом с `seeThrough`/`parallax`/`volume`/`shadow` (там лежат те же
объекты — «одни числа на обе стороны»).

## 4.3. `src/client/parts/Tank.js`

### а) Спрайты → `PerspectiveMesh`

`this.body`, `this.gun`, `this.wreck` (конструктор, `:98-197`) становятся
`PerspectiveMesh` из `pixi.js`:

```js
new PerspectiveMesh({
  texture,
  verticesX: tiltConfig.vertices,
  verticesY: tiltConfig.vertices,
});
```

Последствия, которые надо разобрать построчно:

- **Якорь.** У `PerspectiveMesh` якоря нет — он берётся в `tiltCorners`
  (`anchorX`/`anchorY`). Для корпуса и остова это `0.5/0.5`, для пушки —
  `this._textures.liveTeamId1.gunAnchor` (сейчас читается в конструкторе,
  `Tank.js`, fallback `0.5`).
- **Масштаб.** Сейчас размер задаётся `body.scale.set(size, size)`
  (`Tank.js:266-272`, `size = _scaleFactor · (1 + _z · shear)`). У меша
  масштаб уходит **внутрь** углов: `tiltCorners` получает уже умноженные
  `width`/`height`. Габариты текстуры — `texture.width/height`.
- **Поворот пушки.** Сейчас `gun.rotation`. Становится параметром
  `rotation` в `tiltCorners` (сама `mesh.rotation` остаётся 0).
- **Смена текстуры** при `condition === 0` / смене команды (`create()`,
  `:206-238`) — `mesh.texture = ...` работает так же.
- **Флаг выключения.** При `tilt.enabled === false` и нулевых
  `pitch`/`roll` углы вырождаются в обычный прямоугольник, то есть меш
  рисует ровно то же, что спрайт. Держать обе ветки не нужно.

### б) Чтение новых полей

`update(data)` (`:240-297`): дописать

```js
this._vz = data[M1_VZ] || 0;
this._pitch = data[M1_PITCH] || 0;
this._roll = data[M1_ROLL] || 0;
```

`|| 0` обязателен — тот же приём, что уже применён к `M1_ENGINE_LOAD`
(короткий ряд иначе даёт `undefined` → `NaN`).

Блок масштаба (`:266-272`) заменить вызовом `_applyTilt()`, который:

1. считает `zScale = 1 + this._z · parallax.shear`;
2. считает `squash` (см. в) и умножает вертикальный габарит на `1 - squash`;
3. зовёт `tiltCorners` для корпуса, пушки и остова и раздаёт результат
   через `mesh.setCorners(...)`.

### в) Приземление

Поле `vz` даёт готовый детектор, одинаковый для своего и чужого танка,
без дополнительного поля в кадре:

```js
// касание: скорость снижения была заметной, а в этом кадре обнулилась
const landed = this._prevVz < -landingConfig.minImpact && this._vz === 0;
```

При `landed`:

- `this._landImpact = Math.min(1, -this._prevVz / landingConfig.fullImpact)`;
- `this._landTimer = landingConfig.duration`;
- вызвать колбэк `this._onLanded?.(this._landImpact)` — его на этапе 5
  подхватят пыль и звук. Колбэк передаётся через `dependencies`, чтобы
  `Tank` не знал про эмиттер (см. 5.4).

`this._prevVz = this._vz` — в конце `update()`.

Просадка считается в `onRender` (не в `update`), потому что она идёт по
времени, а не по кадрам сети. `_updateView()` (`:299-326`):

```js
if (this._landTimer > 0) {
  this._landTimer = Math.max(0, this._landTimer - Ticker.shared.deltaMS);
  const t = this._landTimer / landingConfig.duration;
  // быстрый удар, медленный возврат: sin даёт горб без библиотек
  this._squash = Math.sin(t * Math.PI) * landingConfig.squash * this._landImpact;
} else {
  this._squash = 0;
}
```

и после этого — `this._applyTilt()`.

> `onRender` у `Container` — аксессор PixiJS: назначать **свойством**
> (`this.onRender = () => this._updateView()`), иначе сеттер затеняется
> методом прототипа и колбэк не регистрируется. Это правило уже
> зафиксировано в `Tank.js` комментарием и проверяется тестами через
> `tank._onRender`.

### г) Тень в полёте

`_updateShadow()` (`:328-357`) уже масштабирует и гасит тень по `_z`
(`shadow.scaleGain`, `alphaFalloff`). Для прыжка этого достаточно: `_z`
теперь превышает уровень отрыва, тень становится крупнее и бледнее сама.
Единственная правка — `shadow.zIndex = levelZ(TANK_BASE_Z - 1,
Math.floor(this._z))`: у прыжка `_z` может превысить максимальный уровень,
поэтому добавить `Math.min(..., LEVEL_MAX)`; `LEVEL_MAX = 7` (потолок
`MAX_LEVELS` движка, `vimp-engine-core/src/map.rs:22`).

## 4.4. Тесты этапа

`tests/client/tilt.test.js` (новый, проект `tanks`, PixiJS не нужен):

1. `нулевой наклон даёт прямоугольник` — углы совпадают с
   `anchor`-прямоугольником с точностью 1e-6.
2. `тангаж поднимает нос` — при `pitch > 0` верхняя пара углов уезжает
   вверх и вширь, нижняя — вниз и вузь.
3. `крен наклоняет борта` — при `roll > 0` правая пара выше левой.
4. `поворот спрайта коммутирует` — `rotation = π/2` при нулевом наклоне
   даёт тот же квад, что поворот прямоугольника.
5. `наклон симметричен` — `pitch` и `-pitch` дают зеркальные квады.

`tests/client/parts/Tank.test.js` (существующий):

6. `регистрирует колбэк onRender` — существующий, обязан проходить.
7. `корпус деформируется на рампе` — после `tank.update(row({pitch: 0.3}))`
   и `tank.onRender()` углы корпуса не образуют прямоугольник.
8. `приземление даёт просадку и гаснет` — ряд с `vz: -8`, затем ряд с
   `vz: 0` → `tank._squash > 0`; после `landing.duration` мс тикера →
   `tank._squash === 0`.
9. `мягкое касание просадки не даёт` — `vz: -0.5` → `vz: 0` →
   `_squash === 0`.
10. `короткий ряд не роняет наклон` — ряд без полей 13..15 не даёт `NaN`
    в углах (регрессия на `|| 0`).

## Готовность этапа

- [x] `npx eslint .`, `npm test` зелёные
- [ ] Ручная проверка: `VITE_MAP='terraces' npm run dev`, `team1`,
      первый респаун, `W` — корпус задирает нос на подъёме, на вылете с
      прогона `0 → 2` летит и просаживается при касании
