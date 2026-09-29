# Этап 1. Копоть и свет остова, погибшего в полёте (Н1, Н2) ✅ выполнен

**Файл:** `src/client/parts/WreckFire.js`.

**Идея.** В ряду `m1` есть `vz` (индекс `M1_VZ = 13`, `src/client/snapshotFields.js`). На земле и на склоне рампы
он ровно `0`, в полёте не `0`: так же его читают `Tank.js:704` и `Dust.js:118`. Если в момент гибели остов в
полёте, копоть откладывается и кладётся в первом ряду с `vz === 0`, то есть в точке и на высоте приземления. Свет
получает честный флаг полёта.

## 1.1. Импорт

Добавить `M1_VZ` в список импорта из `'../snapshotFields.js'` (стр. 20–28).

## 1.2. `_readRow(data)` (стр. 101–114)

После строки `this._physLevel = …` добавить

```js
    // полёт: 0 на земле и на склоне рампы (как Tank/Dust)
    this._vz = data[M1_VZ] || 0;
```

## 1.3. Конструктор

Рядом с `this._scorch = null;` (стр. 85) добавить `this._scorchPending = false;` с комментарием
`// копоть ждёт приземления остова (погиб в полёте)`. Там же объявить остальные поля копоти, которые сейчас
появляются только в `_addScorch`: `_scorchX`, `_scorchY`, `_scorchZ`, `_scorchLevel` = `0`, `_scorchScale` = `1`,
`_scorchAge` и `_scorchAlpha` = `0`. Тогда у объекта одна форма, и видно, какие поля у него есть (так же
конструктор уже объявляет остальные поля). Поле `_vz` задаёт `_readRow` (1.2): он зовётся в конструкторе первым.

## 1.4. `_addScorch()` (стр. 290–320)

Сразу после существующего раннего выхода `if (!wreckFx.scorch.enabled || !asset || !this.parent) { return; }`
вставить

```js
    // в полёте земли под остовом ещё нет: копоть ляжет там, где он
    // приземлится (update), а не повиснет в воздухе на высоте гибели
    if (this._vz !== 0) {
      this._scorchPending = true;
      return;
    }

    this._scorchPending = false;
```

Остальное тело не менять: оно берёт текущие `_x/_y/_z/_level`, то есть уже точку приземления. Комментарий над
методом дополнить: «копоть — сиблинг на сцене в точке гибели (погиб в полёте — в точке приземления)…».

## 1.5. `update(data)` (стр. 116–148)

После блока `if (this._active) { … follow … }` и ДО чтения `condition` с ранним `return` вставить

```js
    // погиб в полёте: копоть — в первом ряду на земле
    if (this._scorchPending && this._vz === 0) {
      this._addScorch();
    }
```

Если в том же ряду пришёл респаун, `_reset()` ниже снимет только что положенную копоть, это безвредно.

## 1.6. Тикер ждёт копоть

Тикер не должен сниматься, пока копоть не легла и не проявилась: иначе `_stepScorch` (он зовётся только из
`_tick`) не доведёт `fadeIn`. Добавить метод рядом с `_stepScorch`:

```js
  // копоть легла и проявилась (или её не будет): после _finish тикер снят,
  // и _stepScorch больше не зовётся
  _scorchSettled() {
    if (this._scorchPending) {
      return false;
    }

    return !this._scorch || this._scorchAge >= wreckFx.scorch.fadeIn;
  }
```

В условие завершения в `_tick` (стр. 532–539) добавить последним `&& this._scorchSettled()`. На практике оно истинно
задолго до ≈33 с: полёт длится доли секунды, `fadeIn` — 400 мс. Условие страхует только от вырожденного случая.

## 1.7. `_reset()` (стр. 787–814)

Рядом с блоком снятия `_scorch` добавить `this._scorchPending = false;`. Без этого остов, погибший в полёте и сразу
воскрешённый новым раундом, положил бы копоть при первом касании земли уже живым танком.

## 1.8. `_stepLight(intensity)` (стр. 671–694)

Заменить `lightLevels(this._physLevel, this._z, false)` на `lightLevels(this._physLevel, this._z, this._vz !== 0)`
и добавить над вызовом комментарий, как в `Tank._updateLights`:
`// на рампе (vz 0) свет идёт в оба соседних уровня, в полёте — в уровень отрисовки`.

## 1.9. Тесты — `tests/client/parts/WreckFire.test.js`

- Хелпер `row` (стр. 22–29): добавить параметр `vz = 0` и поставить его на индекс 13:
  `[x, y, 0, 0, 0, 0, 0, condition, size, 1, 0, z, level, vz, 0, 0]`. Существующие тесты не меняются, по
  умолчанию `vz = 0`.
- Новый `describe('WreckFire: гибель в полёте', …)`:
  1. «копоть ждёт приземления и ложится в точке касания»:
     - `const { part, stage } = ignited({ z: 0.6, vz: -2 })`;
     - ожидать `scorchesOf(stage, part)` длины 0 и `part._scorchPending === true`;
     - `part.update(row({ condition: 0, x: 130, z: 0, vz: 0 }))`;
     - ожидать одну копоть, `part._scorchPending === false`, `part._scorchX === 130`, `part._scorchZ === 0`,
       `scorchesOf(stage, part)[0].zIndex === levelZ(2, 0)`.
  2. «тикер ждёт копоть»:
     - `ignited({ z: 0.6, vz: -2 })`;
     - `run(part, emissionEnd(wreckFx.fire, wreckFx.smoke) + wreckFx.smoke.lifetime.max)`;
     - ожидать `part._tickListener !== null`;
     - `part.update(row({ condition: 0, vz: 0 }))`, затем `run(part, wreckFx.scorch.fadeIn + 100)`;
     - ожидать `part._tickListener === null`, `typeof part._onRender === 'function'` и
       `part._scorchAlpha` ≈ `wreckFx.scorch.alpha`.
  3. «респаун до приземления — копоти нет и после касания»:
     - `ignited({ z: 0.6, vz: -2 })`;
     - `part.update(row({ condition: 3, z: 0.6, vz: -2 }))` — респаун ещё в полёте;
     - `part.update(row({ condition: 3, vz: 0 }))` — касание земли живым танком;
     - ожидать `part._scorchPending === false` и копоти на сцене нет.

     Респаун именно в полёте: с `vz: 0` в ряду респауна копоть кладётся и тут же снимается `_reset`, и тест не
     ловит потерю сброса из 1.7.
  4. «свет в полёте — только уровень отрисовки, на рампе — два уровня»:
     - `ignited({ z: 0.5, vz: -1 })`, `part._tick(100)`;
     - последний вызов `deps.lighting.updateLight` получает патч с `levels: [0]`;
     - затем `part.update(row({ condition: 0, z: 0.5, vz: 0 }))`, `part._tick(100)`;
     - ожидать `levels: [0, 1]`. Для справки: `lightLevels(0, 0.5, true) → [renderLevel(0, 0.5)] = [0]`,
       `lightLevels(0, 0.5, false) → [0, 1]`, `src/client/lighting/lightMath.js:130`.

Если хелпер `ignited` не пробрасывает `vz` в `row`, дописать это в хелпер.

## 1.10. Документация

en и ru в одном изменении. В таблице `wreckFx`, строка `scorch`:
- `docs/en/configuration.md`: «The mark on the ground at the point of death, lasting until the respawn» →
  «The mark on the ground at the point of death (a tank killed in flight — where the wreck lands), lasting until
  the respawn»;
- `docs/ru/configuration.md`: то же по-русски («…в точке гибели (погиб в полёте — там, где остов приземлился)…»).

## 1.11. `CHANGELOG.md`

Функция выпущена в 0.22.11, поэтому в `## [Unreleased]` добавить:

```md
### Fixed

- A tank destroyed in mid-air (jumping off a ramp or falling off a bridge) no
  longer leaves its scorch mark hanging in the air: the mark appears where the
  wreck lands, and the fire's night glow no longer spills into two levels while
  the wreck falls.
```

Выпущенную запись `## [0.22.11]` не трогать.

## Проверка этапа

`npx eslint . --quiet`, `npm test -- --silent`: зелёные, тестов +4.

> Общий контекст, находки и правила — в [README.md](README.md).

## Итог выполнения

- Правки 1.1–1.11 внесены. Тестов 1110 (+4), eslint чисто, prettier `--check` чисто.
- Контрольные поломки: отключить отложенную копоть, вернуть флаг полёта `false`, убрать сброс ожидания в
  `_reset`, убрать `_scorchSettled()` из условия завершения. Каждая роняет свой тест.
- Отступление: тест 3 делает респаун ещё в полёте (см. 1.9), иначе он не проверяет 1.7.
