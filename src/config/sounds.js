// Громкости пересчитаны под нормализованный webm: до правки
// scripts/process-audio.js фильтры (`-af`) действовали только на mp3, то
// есть на ветку Safari, а webm — кодек Chrome, Firefox и Edge — шёл сырым и
// был разбросан на 11 LU. Каждое значение домножено на 10^(-Δ/20), где Δ —
// замеренная разница интегральной громкости webm до и после нормализации
// (двигатель −20.6 → −16.0 LUFS, взрыв −9.6 → −15.0), поэтому на слух
// громкость каждого звука осталась той же, что была. Уровни проверяются
// `npm run audio:check`.
//
// Прежний баланс этим сохранён целиком: взрыв по-прежнему на ~9 дБ громче
// холостого хода. Исключение — двигатель: он терялся на слух, и его
// громкость поднята отдельно (см. ниже). Остальные значения правятся на
// слух в `npm run dev` (Howler.volume = 0.7 в движковом SoundManager).
const sounds = {
  // https://freesound.org/people/joepayne/sounds/413201/
  roundStart: { file: 'round-start', priority: 200, volume: 0.35 },
  // https://pixabay.com/sound-effects/silly-trumpet-2-187807/
  victory: { file: 'victory', priority: 200, volume: 0.38 },
  // https://pixabay.com/sound-effects/silly-trumpet-11-187806/
  defeat: { file: 'defeat', priority: 200, volume: 0.5 },

  // https://pixabay.com/sound-effects/metal-hit-sound-effect-241374/
  frag: { file: 'frag', priority: 150, volume: 0.26 },
  // https://freesound.org/people/SamsterBirdies/sounds/581598/
  hit: { file: 'hit', priority: 150, volume: 0.36 },
  // https://freesound.org/people/obstgegenrechz/sounds/267980/
  gameOver: { file: 'game-over', priority: 150, volume: 0.31 },

  // https://freesound.org/people/GaryQ/sounds/127845/
  shot: { file: 'shot', priority: 100, volume: 0.51 },
  // https://freesound.org/people/studiomandragore/sounds/401628/
  explosion: { file: 'explosion', priority: 100, volume: 0.74 },
  // https://pixabay.com/sound-effects/start-stop-stopwatch-364924/
  // https://freesound.org/people/vibe_crc/sounds/47988/
  bombHasBeenPlanted: {
    file: 'bomb-has-been-planted',
    priority: 90,
    volume: 0.48,
  },

  // https://freesound.org/people/7of9Designs/sounds/640204/
  tankLanding: { file: 'tank-landing', priority: 60, volume: 0.7 },

  // https://freesound.org/people/monosfera/sounds/572294/
  // громче остальных и с запасом на холостые: множитель холостого хода в
  // Tank.js — 0.6, поэтому эффективная громкость стоящего танка 0.5 × 0.6 =
  // 0.3 (было 0.29 × 0.9 = 0.26), а на ходу двигатель звучит в полный голос
  tankEngine: { file: 'tank-engine', priority: 50, loop: true, volume: 0.5 },
};

export default {
  codecList: ['webm', 'mp3'],
  path: '/sounds/',

  // Геометрия пространственного звука. Числа в МИРОВЫХ единицах: у танков
  // mapScale 0.3 и baseScale 5, то есть мировая единица впятеро меньше
  // экранного пикселя, и движковые дефолты (180/40, рассчитанные на 1:1)
  // здесь дали бы стереобазу в пять раз шире экрана.
  spatial: {
    mode: 'topDown',

    // половина видимой высоты экрана: 1080 / 2 / 5 = 108 мировых единиц.
    // На краю экрана (192 ед. вбок) это угол ~60°, у корпуса — единицы
    // градусов
    virtualElevation: 108,

    // полудиагональ корпуса m1: 8 x 6 мировых единиц (motion.rs: size*4 x
    // size*3 при size: 2) -> hypot(8, 6) / 2 = 5. Взрыв внутри габарита
    // распределяется поровну в оба уха
    innerRadius: 5,
  },

  sounds,
};
