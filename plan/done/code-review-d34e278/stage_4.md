# Этап 4. Конфиг вспышек: общий «рецепт» пламени, мёртвое поле `sideWidth` (К1) ✅ выполнен

**Файл:** `src/config/render.js`. Это рефакторинг без изменения значений. Docs и CHANGELOG не трогать: таблицы
`muzzleFlash`/`impactFlash` в `docs/*/configuration.md` описывают поля, а не способ их записи. В таблице
`impactFlash` там одна строка «all fields», `sideWidth` не упоминается — проверено.

## Проблема (проверено)

В `src/config/render.js` три объекта повторяют одни и те же значения:
- `tracer` (~стр. 386): `color: 0xff9a4a`, `coreColor: 0xfff4e0`;
- `muzzleFlash` (~стр. 435): те же `color`/`coreColor` с комментарием «те же цвета, что у трассера: горящий
  фосфор и раскалённое ядро», плюс `layers` (три слоя), `shrink: 0.3`, `ring.color: 0xffe2b0`;
- `impactFlash` (~стр. 482): дословно те же `layers`, `shrink: 0.3`, `color`, `coreColor`, `ring.color: 0xffe2b0`.

Docs тоже говорят «the same as the tracer's» (`docs/en/configuration.md`, таблица `muzzleFlash`, строка
`color`, `coreColor`). Правка одного места молча разведёт остальные.

`impactFlash.sideWidth: 0` — мёртвое поле. `rollMuzzleFlash` (`src/client/parts/effects/shot/MuzzleFlashEffect.js`)
при `sideLength: 0` не создаёт боковых выбросов (`const sides = config.sideLength ? […] : []`), а `sideWidth`
читается только в цикле по `roll.sides`.

## Решение

### 4.1. Общие константы

Непосредственно над комментарием к `tracer` (`// трассер выстрела hitscan …`, ~стр. 384) вставить, не экспортируя:

```js
// цвета горящего фосфора: трассер, пламя у дула и разрыв снаряда светят
// одним цветом (аддитивно) — пламя и раскалённое ядро
const phosphorColors = { color: 0xff9a4a, coreColor: 0xfff4e0 };

// мягкий край пламени вспышек (`muzzleFlash`, `impactFlash`): те же языки,
// нарисованные слоями — шире и тусклее снаружи, уже и ярче внутри.
// `core: true` — слой цвета ядра
const flameLayers = [
  { scale: 1.35, alpha: 0.18 },
  { scale: 1, alpha: 0.45 },
  { scale: 0.55, alpha: 0.95, core: true },
];

// к концу вспышка скорее гаснет, чем сжимается: размер падает только на эту
// долю
const flameShrink = 0.3;

// цвет ударной волны вспышек
const shockRingColor = 0xffe2b0;
```

Константы должны стоять **выше** `tracer`: объекты модуля вычисляются по порядку.

### 4.2. `tracer`

Строки

```js
  color: 0xff9a4a,
  coreColor: 0xfff4e0,
```

заменить на `...phosphorColors,`. Комментарий над ними («цельная линия, «как в кино»…») и поля `coreWidth`,
`glowWidth`, `glowAlpha` не трогать.

### 4.3. `muzzleFlash`

- `ring: { …, color: 0xffe2b0 }` → `color: shockRingColor`;
- значение `layers: [ … ]` → `layers: flameLayers,`. Комментарий над полем («мягкий край: …») оставить;
- `shrink: 0.3,` → `shrink: flameShrink,`. Комментарий над полем оставить;
- последние строки `color: 0xff9a4a,` и `coreColor: 0xfff4e0,` → `...phosphorColors,`. Комментарий «те же цвета,
  что у трассера: …» заменить на `// те же цвета, что у трассера (phosphorColors)`.

### 4.4. `impactFlash`

Итоговый вид (значения прежние, `sideWidth` удалён):

```js
export const impactFlash = {
  duration: 110,
  spikes: 6,
  length: 8,
  width: 3,
  spread: 1.1,
  jitter: 0.5,
  sideLength: 0,
  ball: { radius: 3.4 },
  ring: {
    radius: 10,
    width: 0.8,
    alpha: 0.3,
    duration: 150,
    color: shockRingColor,
  },
  layers: flameLayers,
  shrink: flameShrink,
  ...phosphorColors,
};
```

`sideLength: 0` оставить: это рабочее поле, оно выключает боковые выбросы через `rollMuzzleFlash`. Комментарий над
объектом («…Поля — как у `muzzleFlash`») дописать: «; боковых выбросов нет (`sideLength: 0`)».

Если `ring` у `muzzleFlash` после замены цвета не влезает в 80 символов, записать его многострочно, как в примере
выше.

## Проверка

```bash
npx vitest run tests/client/parts/effects tests/config --reporter=dot
npx eslint . --quiet
npx vitest run --reporter=dot
```

Тесты сравнивают с объектами конфига, значения не изменились, поэтому всё зелёное без правок тестов. Для
контроля: `node -e "import('./src/config/render.js').then(m => console.log(JSON.stringify([m.tracer.color, m.muzzleFlash.layers, m.impactFlash])))"`.
В выводе должны быть прежние числа и не должно быть `sideWidth`.

## Критерий готовности

- В `render.js` литералы `0xff9a4a`, `0xfff4e0`, `0xffe2b0` и массив слоёв встречаются по одному разу (в
  константах). Проверка: `grep -n "0xff9a4a\|0xfff4e0\|0xffe2b0\|scale: 1.35" src/config/render.js`.
- У `impactFlash` нет `sideWidth`. Тесты и линтер зелёные.
