import maps from '../data/maps/index.js';
import models from '../data/models.js';
import weapons from '../data/weapons.js';
import snapshot from './snapshot.js';

// Игровая половина бывшего src/config/game.js: команды, панель, статистика,
// клавиши игрока, карты и баланс. Движковые дефолты хоста —
// src/config/hostDefaults.js; merge выполняет host.worker.js.
// Этот объект — HostPlugin.gameConfig.
export default {
  parts: {
    models,
    weapons,
    mapConstructor: 'Map', // название конструктора карт
    hitscanService: 'HitscanService', // сервис вычисления стрельбы hitscan
    friendlyFire: false, // огонь по своей команде
  },

  // снапшот-схема (ключи/раскладка бинарного протокола) — игровая:
  // движок передаёт её ядру и клиенту, не зная содержимого
  snapshot,

  // маппинг движковых событий на имена звуков игры (SocketManager.sendSoundCue)
  soundCues: {
    roundStart: 'roundStart',
    victory: 'victory',
    defeat: 'defeat',
    frag: 'frag',
    death: 'gameOver',
  },

  // голосование, отправляемое игроку после первого кадра (выбор команды)
  initialVote: 'teamChange',

  maps, // карты игры
  mapScale: 0.3, // масштаб карт
  currentMap: 'pool mini', // название карты по умолчанию
  mapsInVote: 4, // количество карт в голосовании
  mapSetId: 'c1', // дефолтный id конструкторов создания карт

  // собственные параметры Rust-ядра игры: движок довозит объект целиком в
  // половину `game` init-JSON, не читая его (lib/coreConfig.js)
  coreParams: {
    // правила 2.5D-уровней; одноуровневые карты их не касаются
    levels: {
      fallTime: 0.35, // с на ОДИН уровень высоты
      fallDamage: 30, // урон за уровень СВЕРХ мёртвой зоны (0 — падение бесплатно)
      // высота дуги, которая ничего не стоит: прыжок с рампы возвращает
      // танк на ту же плиту. При freeHeight 0.5 и fallDamage 30 падение
      // ровно с одного уровня стоит прежние 15 HP
      fallDamageFreeHeight: 0.5,
      maxFallDamage: 100, // потолок урона падения
      // уклон безразмерный (`rise * levelHeight / span`): на демо-картах
      // 0.11 (rampLong) … 0.5 (rampSteep)
      climbGravity: 500, // мировых единиц/с² на единицу продольного уклона
      climbMaxSpeedFactor: 0.5, // множитель макс. скорости при уклоне 1.0
      // сколько кадров подряд кадр обязан держать уровень ВЫШЕ реплики,
      // чтобы она приняла подъём: понижение принимается сразу, а подъём
      // отличается от запоздавшего кадра только стойкостью несогласия
      levelAdoptFrames: 8,
      // потолок скачка высоты при заезде на горку сбоку или наискось
      // (в уровнях); граница исключающая
      maxSideEntryRise: 0.5,
      // множитель вертикальной скорости на вылете с верхнего торца
      // рампы: 0 — прыжка нет вовсе, 1 — вся вертикальная составляющая
      // скорости на уклоне уходит в полёт. 1.0 давал на крутом прогоне
      // `terraces` дугу в 2.6 уровня (замер), поэтому доля
      rampLaunchFactor: 0.35,
      // порог вылета (уровней/с): ниже него прыжок не начинается, иначе
      // съезд по рампе шагом рождал бы микропрыжки на каждой клетке
      minLaunchVz: 0.35,
      // потолок вылета (уровней/с). При g = 2/fallTime² = 16.33 он задаёт
      // максимальную дугу: vz²/(2g) = 0.375 уровня. Обязан быть НИЖЕ
      // jumpClearance, иначе штатный прыжок перелетает стены и периметр
      maxLaunchVz: 3.5,
      // насколько выше уровня взлёта (в уровнях) танк перестаёт видеть
      // стены — то есть перепрыгивает препятствия. Выше максимальной дуги
      // (см. maxLaunchVz): перелёт остаётся механикой ядра, но штатным
      // прыжком недостижим — карте, которой он нужен, достаточно поднять
      // rampLaunchFactor/maxLaunchVz
      jumpClearance: 0.45,
      // во сколько раз безразмерный уклон превращается в угол наклона
      // корпуса (1 — наклон равен арктангенсу уклона)
      tiltGain: 2.0,
      // наклон носа в полёте: радиан на единицу вертикальной скорости
      tiltAirGain: 0.12,
      // скорость возврата корпуса к целевому наклону, 1/с
      tiltResponse: 12.0,
      // потолок наклона по модулю, рад
      tiltMax: 0.6,
      // тряска камеры на приземлении (у оружия она задаётся так же —
      // `cameraShake` в src/data/weapons.js); отсутствие блока = тряски
      // нет. Пороги minImpact/fullImpact численно повторяют `landing` из
      // src/config/render.js (просадка, пыль и звук на клиенте) — общего
      // источника у рендера и WASM нет, менять только парой
      landingShake: {
        // при полном ударе, единицы как у оружия. 6 читалось как удар по
        // экрану на каждом прыжке; падение с уровня даёт k ≈ 0.94, то
        // есть почти всю интенсивность, поэтому число задаёт силу именно
        // ПАДЕНИЯ, а не прыжка
        intensity: 3,
        duration: 220, // мс
        minImpact: 1.5, // ниже — мягкое касание, тряски нет
        fullImpact: 6, // уровней/с, дающие полную интенсивность
      },
    },
    // поверхности клеток: карта размечает тайлы полем `game.surfaces`, смысл
    // типов задаётся здесь. Значения стартовые. Множители: accel — тяга,
    // maxSpeed — потолок скорости, grip — боковое сцепление, brake —
    // торможение без газа, turn — поворот (нейтрально 1). Добавки: drag —
    // линейное сопротивление, angularDrag — угловое, 1/с (нейтрально 0;
    // отрицательное ослабляет демпфирование, не ниже −damping.angular модели)
    surfaces: {
      trackYawGain: 0.004, // Δω на единицу разницы тяги гусениц (1/ед. длины)
      trackSampleX: 0.6, // точки вдоль корпуса, доля полудлины
      trackSampleY: 0.75, // линия гусеницы, доля полуширины
      bodyBeltCoupling: 4.0, // связь ящика/бочки с лентой конвейера, 1/с
      types: {
        sand: { accel: 0.6, maxSpeed: 0.55, drag: 1.2, grip: 1.0, brake: 1.0, turn: 0.8 },
        mud: { accel: 0.45, maxSpeed: 0.4, drag: 2.0, grip: 0.9, brake: 1.0, turn: 0.7 },
        water: { accel: 0.7, maxSpeed: 0.6, drag: 1.5, grip: 0.8, brake: 0.8, turn: 0.85 },
        oil: {
          accel: 0.35,
          maxSpeed: 1.0,
          drag: 0.0,
          grip: 0.08,
          brake: 0.1,
          turn: 1.6,
          angularDrag: -0.5,
        },
        conveyor: { belt: 60 }, // ед./с по стрелке
        // разовый импульс по стрелке при въезде; оба поля при boostDv обязательны
        boost: { boostDv: 160, boostMaxSpeed: 340, minEntrySpeed: 20 },
      },
    },
    // разрушаемые тела карты: карта назначает тип полем
    // `physicsDynamic[i].game.prop`. Значения стартовые, мир — в единицах
    // после mapScale (максимальная скорость танка 260). damagedAt — доля HP,
    // ниже которой тело «повреждено» (0 — стадии нет); bulletFactor/
    // blastFactor — множители урона выстрела и взрыва; ramThreshold —
    // скорость удара вдоль нормали, ниже которой таран урона не наносит;
    // ramDamagePerSpeed — урон за единицу превышения; chainDelay — задержка
    // детонации от чужого взрыва, с (обязательна при blast)
    props: {
      fence: {
        hp: 30,
        damagedAt: 0,
        bulletFactor: 1.0,
        blastFactor: 1.0,
        ramThreshold: 60,
        ramDamagePerSpeed: 0.5,
      },
      crate: {
        hp: 120,
        damagedAt: 0.5,
        bulletFactor: 0.5,
        blastFactor: 1.5,
        ramThreshold: 140,
        ramDamagePerSpeed: 0.6,
      },
      barrel: {
        hp: 40,
        damagedAt: 0,
        bulletFactor: 1.0,
        blastFactor: 1.0,
        ramThreshold: 150,
        ramDamagePerSpeed: 1.0,
        chainDelay: 0.15,
        blast: { radius: 70, damage: 80, impulse: 2500000, cameraShake: { intensity: 30, duration: 400 } },
      },
    },
  },

  // рамки настроек комнаты в лобби (GameManifest.roomDefaults)
  roomDefaults: {
    maxPlayers: 8, // целевой размер комнаты (рамка P2P-плана)
  },

  // схема формы создания сервера (GameManifest.roomForm, движок v3): имена =
  // ключи roomDefaults; default НЕ указываем — движок засеивает его из
  // roomDefaults (mergeRoomDefaults). regExp для maxPlayers/roundTime/mapTime
  // здесь не указан — его накладывает build-game-manifest.js точным
  // диапазонным паттерном (rangeToPattern) из тех же чисел, что клампует
  // applyRoomOverrides.js (roomDefaults.maxPlayers; hostDefaults.timers
  // roomTimeMin/roomTimeMax) — единый источник, не независимая копия.
  // unit:'s' — движок делит мс на 1000 для показа; numeric:true — текстовое
  // поле хранит и валидирует число. build-game-manifest.js кладёт рядом с
  // regExp ещё и min/max из тех же чисел: движок показывает их подсказкой
  // «(min–max)» в подписи поля и проверяет сам, строкой в #lobby-error
  // (нативных браузерных попапов больше нет). Всё это UX-подсказка, не
  // авторитетная граница: значения всё равно клампятся в
  // applyRoomOverrides.js движка
  roomForm: [
    { name: 'maxPlayers', control: 'text', label: 'Max players', numeric: true },
    { name: 'roundTime', control: 'text', label: 'Round time', unit: 's', numeric: true },
    { name: 'mapTime', control: 'text', label: 'Map time', unit: 's', numeric: true },
    { name: 'friendlyFire', control: 'checkbox', label: 'Friendly fire' },
    { name: 'map', control: 'select', label: 'Map', source: 'maps' },
  ],

  stat: {
    name: {
      key: 0,
      bodyMethod: '=',
      headSync: true,
      headMethod: '#',
    },
    status: {
      key: 1,
      bodyMethod: '=',
      bodyValue: '',
      headValue: '',
    },
    score: {
      key: 2,
      bodyMethod: '+',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    deaths: {
      key: 3,
      bodyMethod: '+',
      bodyValue: 0,
      headMethod: '+',
      headValue: 0,
    },
    latency: {
      key: 4,
      bodyMethod: '=',
    },
  },

  // rank/state игрока (Этап B4): rank — числовой рейтинг per (user, game),
  // state — непрозрачный для движка JSON ("скиллы"); defaultState — то, с
  // чем стартует игрок без сохранённой записи на auth-сервисе
  playerState: {
    defaultState: {},
  },

  panel: {
    // схема полей панели (стартовые значения ресурсов; уходит и в ядро)
    fields: {
      health: {
        key: 'h',
        value: 100,
      },
      w1: {
        key: 'w1',
        value: 200,
      },
      w2: {
        key: 'w2',
        value: 100,
      },
    },
    // ключ активного оружия в кадрах панели
    activeKey: 'wa',
  },

  // параметры scripted-участников (ботов): префикс имени Bot<id>,
  // модель танка по умолчанию
  scripted: {
    namePrefix: 'Bot',
    defaultModel: 'm1',
  },

  spectatorTeam: 'spectators', // название команды наблюдателя

  teams: {
    team1: 1,
    team2: 2,
    spectators: 3,
  },

  // конфигурация клавиш активного игрока
  // type - тип отработки нажатия на клавишу (по умолчанию 0):
  // 0 : многократное нажатие (начинается на keyDown, завершается на keyUp)
  // 1 : выполняется один раз на keyDown
  playerKeys: {
    // forward (w)
    forward: {
      key: 1 << 0,
    },
    // back (s)
    back: {
      key: 1 << 1,
    },
    // left (a)
    left: {
      key: 1 << 2,
    },
    // right (d)
    right: {
      key: 1 << 3,
    },
    // gun center (u)
    gunCenter: {
      key: 1 << 4,
      type: 1,
    },
    // gun left (k)
    gunLeft: {
      key: 1 << 5,
    },
    // gun right (l)
    gunRight: {
      key: 1 << 6,
    },
    // fire (j)
    fire: {
      key: 1 << 7,
      type: 1,
    },
    // next weapon (n)
    nextWeapon: {
      key: 1 << 8,
      type: 1,
    },
    // prev weapon (p)
    prevWeapon: {
      key: 1 << 9,
      type: 1,
    },
  },
};
