# Конфигурация (игра-плагин)

Эта страница описывает собственную конфигурацию `vimp-tanks` — игровую
половину контракта, описанного в
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/plugin-api.md)
движка. Про конфигурацию самого движка (переменные окружения,
`hostDefaults`, конфиг master/lobby, порты/opcodes) — см.
[configuration.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/configuration.md)
движка.

`src/config/game.js` (половина хоста) и `src/config/client.js` (половина
клиента) отдаются движку через `HostPlugin.gameConfig` и
`HostPlugin.buildClientGameConfig()`; `src/config/auth.js` — через
`HostPlugin.authSchema`; `src/config/sounds.js` и `src/config/snapshot.js`
попадают в клиентский конфиг и кодек снапшотов соответственно.

## src/config/game.js — игровой конфиг

Импортирует карты, модели и оружие из `src/data/`.

### Основные параметры

| Параметр | Значение | Описание |
| --- | --- | --- |
| `parts.friendlyFire` | `false` | Урон по своей команде |
| `parts.mapConstructor` | `'Map'` | Имя конструктора карт |
| `parts.hitscanService` | `'HitscanService'` | Сервис расчёта hitscan-выстрелов |
| `mapScale` | `0.3` | Масштаб карт |
| `currentMap` | `'pool mini'` | Карта по умолчанию |
| `mapsInVote` | `4` | Количество карт в голосовании |
| `mapSetId` | `'c1'` | Дефолтный snapshot-ключ конструктора карты |
| `roomDefaults.maxPlayers` | `8` | Рамка настроек комнаты в лобби: кламп лимита, выбранного создателем (также публикуется в `GameManifest.roomDefaults`) |
| `roomForm` | 5 дескрипторов полей | Схема формы создания комнаты (публикуется как `GameManifest.roomForm`, контракт форм v3 движка): по дескриптору на каждый ключ `roomDefaults` (`maxPlayers`, `roundTime`, `mapTime`, `friendlyFire`, `map`), у каждого — `control` (`text`/`checkbox`/`select`) и `label`; `default` не указывается — движок засеивает значения из `roomDefaults`. Границы времени (`roundTime`/`mapTime`) — в мс; `map` использует `source: 'maps'`, варианты движок берёт из каталога карт |
| `scripted` | `namePrefix: 'Bot', defaultModel: 'm1'` | Параметры scripted-участников (ботов): префикс имени `Bot<id>` и модель танка по умолчанию |
| `soundCues` | `roundStart, victory, defeat, frag, death: 'gameOver'` | Маппинг движковых событий на имена звуков этой игры (`SocketManager.sendSoundCue`) |
| `initialVote` | `'teamChange'` | Голосование, отправляемое игроку после первого кадра |
| `spectatorTeam` | `'spectators'` | Название команды наблюдателей |
| `teams` | `team1: 1, team2: 2, spectators: 3` | Команды и их id |

### Статистика (`stat`)

Описывает столбцы scoreboard. Для каждого параметра:

- `key` — порядковый номер ячейки в строке;
- `bodyMethod` — метод обновления в теле таблицы (`=` — замена, `+` — прибавление);
- `bodyValue` — значение по умолчанию;
- `headSync` — синхронизировать body с head;
- `headMethod` — метод обновления в шапке (`#` — количество значений, `=` — замена, `+` — прибавление);
- `headValue` — значение по умолчанию в шапке.

Текущие столбцы: `name` (0), `status` (1), `score` (2), `deaths` (3),
`latency` (4). Движковый механизм Stat пишет только в объявленные схемой
колонки — игра может опустить любую из них.

### Rank/state игрока (`playerState`)

Механику синхронизации (движковая сторона) см. в
[auth.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/auth.md#загрузка-и-синхронизация-rank-и-state-хост)
и
[host.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/host.md#синхронизация-rank-и-state-игрока-этап-b4)
движка. Эта игра объявляет дефолтную форму непрозрачного per-player блока
«скиллов»:

| Параметр | Значение | Описание |
| --- | --- | --- |
| `playerState.defaultState` | `{}` | С чем стартует участник, если у auth-сервиса нет сохранённой записи для него (или он недоступен на входе) |

Движок обращается с `state` как с непрозрачным JSON-блобом — форму
интерпретирует только эта игра. У `rank` (простой числовой аккумулятор
дельты по убийствам, ±1 за фраг) своей конфиг-схемы нет — это просто
число.

### Панель HUD (`panel`)

Схема панели: `fields` — поля со строковыми ключами и дефолтными
значениями ресурсов игрока (обновляются каждый раунд, также уходят в
ядро), `activeKey` — ключ активного оружия в кадрах панели:

- `fields.health` → ключ `h`, значение `100`;
- `fields.w1` → ключ `w1`, `200` патронов;
- `fields.w2` → ключ `w2`, `100` бомб;
- `activeKey: 'wa'`.

Клиентское сопоставление ключей элементам DOM — в `client.js`
(`modules.panel.keys`, включая `t` — время и `wa` — активное оружие).

### Клавиши (`playerKeys`)

Команды игрока. Каждая клавиша имеет битовую маску `key` (`1 << n`,
используется предиктором и ядром в истории ввода) и опциональный `type`:

- `type: 0` (по умолчанию) — многократное действие: начинается на
  keyDown, завершается на keyUp (движение, поворот башни);
- `type: 1` — срабатывает один раз на keyDown (`gunCenter`, `fire`,
  `nextWeapon`, `prevWeapon`).

Соответствие keyCode → команда задаётся в `client.js` →
`modules.controls.keySetList`. Набор наблюдателя — движковый.

## src/config/client.js — игровая половина CONFIG_DATA

Поставляется через `HostPlugin.buildClientGameConfig()`, объединяется
движковым `buildClientConfig.js` со своим `clientDefaults.js`.

### `parts` — игровые сущности

- **`gameSets`** — сопоставление snapshot-ключей классам рендеринга:

  ```js
  gameSets: {
    c1: ['Map', 'MapRadar'],
    c2: ['Map'],
    m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks'],
    w1: ['ShotEffect'],
    w2: ['Bomb'],
    w2e: ['ExplosionEffect'],
  }
  ```

  Один ключ может создавать несколько сущностей (танк рисуется и на
  основном полотне, и на радаре, плюс дым и следы гусениц).

- **`entitiesOnCanvas`** — на каком полотне (`vimp` или `radar`)
  отрисовывается каждый класс. Сущности можно наследовать и отображать на
  разных полотнах (например, `MapRadar` — упрощённая карта для радара).

- **`bakedAssets`** — процедурные текстуры, «запекаемые» один раз при
  старте (`BakingProvider`, движковый механизм): взрывы, частицы, дым,
  танк, бомба, следы гусениц, отметки радара. Каждая запись: `name` (id
  текстуры), `component` (кому назначена), `params` (параметры
  генерации). `explosionTexture`, `smokeTexture` и
  `impactParticleTexture` пекутся одним baker'ом `blurredCircleTexture`
  и различаются только `params` (`radius`, `blur`, `quality`, `color`);
  он возвращает `{ texture, contentSize }`, где `contentSize` — диаметр
  нарисованного круга без запаса под размытие.

  `funnelTexture` печёт не одну текстуру, а набор силуэтов воронки
  (`variants`), из которого `FunnelEffect` берёт случайный, чтобы след
  не повторялся. Заливка двухтоновая: тёмная выемка (`colorFill`) видна
  на светлых картах, светлый бортик выброса (`colorRim`, `rimWidth`) —
  на тёмных. Возвращает `{ textures, contentSize }` с той же семантикой
  `contentSize`. `blur` сильнее ~1/4 `baseRadius` размазывает пятно на
  весь холст, и бортик перестаёт читаться.

- **`componentDependencies`** — какие сервисы инжектируются в компоненты
  (`renderer` → Map; `assetsBase` → Map; `soundManager` → ExplosionEffect,
  ShotEffect, Bomb, Tank; `mapDynamics` → ShotEffect). `mapDynamics` —
  геометрия динамики карты из клиентского ядра (`toWorld(key, localX, localY)`
  поверх `ClientCore.map_dynamics_to_world`), которую в пул кладёт сам плагин
  (`hooks.services`, см. [architecture.md](architecture.md)): эффект выстрела
  держит якорь на теле и спрашивает, где тело нарисовано, в момент рождения
  попадания. Сервис есть только при включённом client-side prediction —
  необъявленный сервис молча приходит как `undefined`. `assetsBase` — движковая база ассетов этого
  пакета: `Map` превращает её в `${assetsBase}img/<файл>` для тайл-листов
  и спрайтов динамических тел, которые он грузит (см.
  [extending.md](extending.md#новая-картинка-карты)).

### `modules.controls.keySetList`

Массив из двух наборов `keyCode: 'команда'`: `[0]` — наблюдатель (`n`/`p`
— переключение наблюдаемого игрока, движковый набор), `[1]` — игрок
(`w/s/a/d` — движение, `k/l/u` — башня, `j` — огонь, `n/p` — смена
оружия). Какой набор активен, диктует хост через порт `17` (KEYSET_DATA).

### Тексты и схемы

- **`chat.messages`** — шаблоны системных сообщений: группы `s`
  (статусы/команды, движок), `v` (голосования, движок), `m` (карты,
  движок), `c` (команды, движок), `n` (имена, движок), `b` (боты, эта
  игра). Хост шлёт только `'группа:номер:параметры'`, текст собирает
  клиент.
- **`panel.fields`** — типизированная схема полей: упорядоченный список
  `{ name, elem, type: 'bar'|'value'|'time'|'weapon', max?, blocks? }` —
  движковый `PanelView` генерирует DOM панели и поведение по типам, а не
  по именам полей.
- **`stat.heads`/`stat.bodies`/`stat.sortList`** — шаблоны таблицы
  scoreboard и параметры сортировки (массив пар `[номер ячейки, по
  убыванию?]`; при равенстве сравнение переходит к следующей паре).
- **`vote.templates`** — `[заголовок с плейсхолдерами {0}, варианты
  (массив — статичные, строка — запросить список у хоста), timeOff]`.
  `menu` — пункты главного меню голосования.
- **`gameInform.list`** — шаблоны игровых сообщений на экране.
- **`initIdList`** — какие модули/полотна инициализировать при старте
  (`vimp`, `radar`, `panel`, `chat`); сама механика инициализации —
  движковая.

Полная таблица владения движок/игра по каждому полю CONFIG_DATA — в
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/plugin-api.md#clientplugin-api)
движка.

## src/config/auth.js — конфиг формы авторизации

Приезжает через `HostPlugin.authSchema`: id DOM-элементов (`elems`),
параметры формы (`params`), валидаторы этой игры (`validators`) и тексты
формы (`texts`: `title` + help-секции `{ heading, lines: [{ keys, text,
last? } | { separator }] }`) — движковый шаблон `auth.pug` нейтрален
(заголовок, справочные секции, кнопка `Start`, без поля `name`: ник берётся
из проверенного токена identity лобби, а не из формы), заголовок и
подсказки этой игры подставляет `AuthView` из `texts`. `elems` указывает
`fieldsId: 'auth-fields'` — контейнер, в который движок рендерит контролы
`params` (контракт форм v3; поля `formId` нет — элементом `<form>`
владеет движок). `params` объявляет только собственное поле игры —
`model` (значение по умолчанию, `options`: `control: 'select'` + `label:
'Model'` + список вариантов из `models.js`, `validator: 'isValidModel'`,
ключ `storage` для localStorage) — поля, использующего движковый
`isValidName`, в форме нет. `control` обязателен для каждого поля в
контракте форм v3: поле с объектом `options`, но без `control`, молча
пропадёт (`console.error` + skip в `formBuilder.buildForm`), а не
свалится сборкой. `isValidModel` (модель есть в `models.js`)
инжектируется в движковый `validateAuth` третьим аргументом. Валидация
выполняется и на клиенте (валидаторы из бандла этой игры), и повторно
хостом (Worker) как итоговым авторитетом; по проводу (`AUTH_DATA`, порт 1)
уходят только `elems`/`params`/`texts` — код валидаторов не передаётся.

## src/config/sounds.js — каталог звуков

Каждый звук: `file` (имя файла без расширения, отдаётся из `dist/sounds/`
под `assetsBase` этого плагина), `priority` (выше — важнее при
конкуренции за голоса), `volume`, опционально `loop: true`.
`codecList: ['webm', 'mp3']` — файлы должны существовать в обоих
форматах. Механика воспроизведения — движковый
[client.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/client.md#soundmanager).

## src/config/snapshot.js — схема snapshot-ключей

Регистрируется как `HostPlugin.gameConfig.snapshot`: `m1`, `w1`, `w2`,
`w2e`, `c1`, `c2` → числовой id + `kind`, задающий байтовую раскладку
блока (движковый schema-driven packer/unpacker, см. [core.md](core.md)).
Незарегистрированный ключ уронит упаковку кадра. У `c1`/`c2` объявлен
`optionalFrom: 3`: динамический элемент карты шлёт `[vx, vy, angvel]`,
только пока движется, — покоящийся ящик экономит 12 байт в каждом кадре
(распаковка всё равно отдаёт полную строку из шести полей, отсутствующий
хвост — нулями). Полная механика —
движковый
[network.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/network.md#бинарный-snapshot-кадр-порт-5).

## src/data/ — игровые данные

### models.js

Единственная модель — танк `m1`: конструктор `Tank`, стартовое оружие
`w1`, размер (`size: 2`, габариты `size×4 : size×3`), параметры движения
(ускорение/торможение, `maxForwardSpeed: 260`, `maxReverseSpeed: −130`,
поворотный момент, демпфирование, боковое сцепление), физика (`density`,
`friction`, `restitution`), «манера вождения» (пороги и скорости
газа/поворота) и башня (`maxGunAngle: 1.4` рад, скорости
поворота/центрирования).

`brakingFactor: 0.3` — коэффициент торможения: чем выше, тем резче танк
останавливается. Значение намеренно низкое — тело танка создаётся с
предиктивными контактами (см. [core.md](core.md#тело-танка)), и торможению
больше не нужно компенсировать ошибки контакта.

> ⚠️ Коэффициенты `models.js` используются и авторитетным путём ядра, и
> репликой клиентского предикта (`core/src/client/predictor.rs`, формулы
> общие — `core/src/motion.rs`). Их изменение проверяется cargo-паритетом:
> `npm run core:test`.

### weapons.js

Два архитектурно разных типа оружия:

| | `w1` (пуля) | `w2` (бомба) |
| --- | --- | --- |
| Тип | `hitscan` — мгновенный луч, физического снаряда нет | `explosive` — физический снаряд `Bomb` в мире Rapier |
| Урон | 40 | 70 в эпицентре, радиус взрыва 50 |
| Дальность | 1500 юнитов | — (детонация по таймеру `time: 300` мс) |
| Кулдаун | 0.01 с | 0.1 с |
| Прочее | `spread: 0`, расход 1 патрон, импульс попадания `7500000` (не зависит от `range`) | `size: 8`, импульс взрыва `2000000`, эффект `w2e` |
| Тряска камеры | 20px / 200мс | 30px / 400мс |

### maps/

Три карты: `pool mini` (малая), `canopy`, `garden`. Каждая описывает слои
тайлов (`layers`, `tiles`), точки респауна (`respawns`), статическую
(`physicsStatic`) и динамическую (`physicsDynamic`) физику. Регистрация —
`src/data/maps/index.js`. Как добавить карту — см.
[extending.md](extending.md#новая-карта).

---

[← Предыдущая: Архитектура](architecture.md) · [Следующая: Игровой процесс →](gameplay.md)
