# Этап 5. Регистрация парта и ассетов ✅ выполнен

1. `src/client/parts/index.js`: `import WreckFire from './WreckFire.js';` и добавить в экспорт.
2. `src/client/bakers/index.js`: `wreckFireTexture: lightRadialTexture`,
   `wreckSmokeTexture: blurredCircleTexture`, `wreckScorchTexture: scorchTexture`; поправить
   комментарий «четыре ассета — один и тот же размытый круг» (станет пять).
3. `src/config/client.js`:
   - `gameSets.m1: ['Tank', 'TankRadar', 'Smoke', 'Tracks', 'Dust', 'WreckFire']`;
   - `entitiesOnCanvas.WreckFire: 'vimp'`;
   - `bakedAssets.vimp` — три записи `component: 'WreckFire'`:
     ```js
     {
       // гибель танка: мягкое пятно с ярким центром — вспышка, огненный шар,
       // языки пламени, искры и отсвет (аддитивно, цвет даёт tint)
       name: 'wreckFireTexture',
       component: 'WreckFire',
       params: { radius: 32, rings: 24, blur: 2 },
     },
     {
       // клубы дыма над остовом: размытый круг, белый — цвет даёт tint
       name: 'wreckSmokeTexture',
       component: 'WreckFire',
       params: { radius: 8, blur: 3, quality: 20, color: 0xffffff },
     },
     {
       // копоть под остовом: те же пятна, что у разрушенного пропа
       name: 'wreckScorchTexture',
       component: 'WreckFire',
       params: { baseRadius: 20, irregularity: 5, blur: 4, numPoints: 16,
         color: 0x15120f, coreColor: 0x060505, coreRatio: 0.5, variants: 3 },
     },
     ```
   - `componentDependencies`: добавить `'WreckFire'` в конец списков `renderer`,
     `soundManager`, `blasts`, `levelView`, `lighting`; поправить их комментарии
     (`blasts` — «эффект взрыва и гибель танка сообщают точку…»).
4. `tests/config/client.test.js`: дополнить ожидаемые массивы `levelView` и `renderer`
   (`'WreckFire'` в конце) и добавить случай: `gameSets.m1` содержит `'WreckFire'`,
   `entitiesOnCanvas.WreckFire === 'vimp'`, `deps.blasts/lighting/soundManager` содержат
   `'WreckFire'`, `clientPlugin.parts.WreckFire` определён, у `WreckFire` три запечённых ассета
   и для каждого имени есть бейкер в `src/client/bakers/index.js`.

> Общий контекст, факты из кода и решение — в [README.md](README.md).
