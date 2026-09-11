import { Ticker } from 'pixi.js';
import { offsetPoint } from '../../parallax.js';
import { advance as advanceHole, apply as applyHole } from './holeOverlay.js';
import {
  parallax as parallaxConfig,
  volume as volumeConfig,
} from '../../../config/render.js';
import { tileAt } from './tileGrid.js';

// See-through статического слоя: плита моста и её перекрыватель уступают
// видимость локальному игроку — в двух режимах (`layer` и `hole`) и для
// двух целей (сам слой и контейнер-перекрыватель). Отдельный модуль:
// у слоя это своя зона ответственности, и в `MapLayer.js` она занимала
// треть файла.
//
// Модуль НИЧЕГО не знает о парте: всё, что ему нужно, приходит одним
// значением `view` (см. `MapLayer._seeThroughView`), а меняет он только
// то, что в этом значении и передано, — alpha и фильтры двух контейнеров
// плюс состояние двух «дыр». Полей парта здесь нет ни одного: иначе
// переименование приватного поля молча ломало бы соседний файл.
//
// `view` — это:
//   levelView   сервис «где локальный игрок»
//   container   сам слой, `occluder` контейнер-перекрыватель (или null)
//   stage       сцена: в её координатах фильтр считает центр дыры
//   hasSprite   запечён ли уже слой (ассеты грузятся асинхронно)
//   hole, occluderHole  состояния «дыры» (`holeOverlay`)
//   level, volume       уровень слоя и его высота в уровнях
//   grid                грид тайлов (`tileGrid`)
//   tileSet, floorSet   наборы тайлов слоя и тайлов пола

// прозрачность плиты моста над локальным игроком: в GTA 2 игрок под
// эстакадой продолжает видеть свою машину. Считается по НАШЕМУ гриду
// уровня: у слоя есть и карта, и список тайлов пола
export function updateSeeThrough(view, camera) {
  if (!view.levelView) {
    return;
  }

  const cfg = view.levelView.cfg;
  // Сглаживание по времени тикера общего приложения — РОВНО раз на тик.
  // Полотно может рисоваться несколько раз за тик (`vimp-engine` до 0.34
  // зовёт `app.render()` из `updateCoords` на каждый кадр камеры), а
  // `deltaMS` у всех этих отрисовок один и тот же: без этой отсечки плита
  // гасла бы тем быстрее, чем больше кадров пришло в тик, то есть
  // `fadeRate` означал бы разное на разном пинге. Нулевой шаг оставляет
  // силу дыры как есть, а её ПРИМЕНЕНИЕ идёт каждую отрисовку: центр дыры
  // едет за камерой
  const tick = Ticker.shared.lastTime;
  const stepped = view.hole.tick === tick;

  view.hole.tick = tick;

  const dt = Ticker.shared.deltaMS / 1000;
  const rate = stepped ? 0 : Math.min(1, cfg.fadeRate * dt);

  if (view.hasSprite) {
    updateLayerSeeThrough(view, cfg, rate, camera);
  }

  if (view.occluder) {
    updateOccluderSeeThrough(view, cfg, rate, camera);
  }
}

// сам слой: гаснет только то, что НАД игроком
function updateLayerSeeThrough(view, cfg, rate, camera) {
  const { levelView, container } = view;

  // путь отхода: гаснет весь слой целиком (прежнее поведение)
  if (levelView.mode === 'layer') {
    const under =
      levelView.level < view.level &&
      tileAt(view.grid, levelView.x, levelView.y, view.floorSet);
    const target = under ? cfg.layerAlpha : 1;

    container.alpha += (target - container.alpha) * rate;

    return;
  }

  // режим 'hole': проверки пола нет — дыра ездит за игроком, и её край
  // сам показывает, где кончается плита
  const above = levelView.level < view.level;

  advanceHole(view.hole, above, rate);
  applyHole(container, view.hole, cfg, levelView, view.stage, camera);
}

// Перекрыватель: гаснет ДВУМЯ путями. Объём чужого уровня НАД игроком —
// как и раньше, вместе со своим слоем (перила моста обязаны исчезать
// вместе с плитой). Объём СВОЕГО уровня — только когда он реально
// закрывает танк: экструзия уходит от центра камеры и накрывает область
// за стеной, поэтому «дыра всегда» превращала стены в полупрозрачные
// пятна и объём переставал читаться.
function updateOccluderSeeThrough(view, cfg, rate, camera) {
  const { levelView, occluder } = view;
  const above = view.level > levelView.level;

  if (levelView.mode === 'layer') {
    // путь отхода: чужой уровень гаснет целиком, свой не гаснет вовсе
    const alpha = above ? cfg.layerAlpha : 1;

    occluder.alpha += (alpha - occluder.alpha) * rate;

    return;
  }

  const hides = above || volumeHidesPlayer(view, camera);

  advanceHole(view.occluderHole, hides, rate);
  applyHole(occluder, view.occluderHole, cfg, levelView, view.stage, camera);
}

// Накрывает ли объём этого слоя нарисованную точку игрока.
//
// Срез объёма на высоте k рисует тайл из мировой точки w в точке
// `w + (w - cam) * k`. Значит по нарисованной точке игрока `p` исходная
// клетка среза считается обратной формулой `w = (p + cam * k) / (1 + k)`:
// если в ней есть тайл этого слоя, срез накрывает танк. Проверяются те же
// k, что и рисуются, — ни одного лишнего среза.
function volumeHidesPlayer(view, camera) {
  if (!camera || !view.grid.map) {
    return false;
  }

  const player = view.levelView;
  const shear = parallaxConfig.shear;
  const point = offsetPoint(player.x, player.y, camera, player.z * shear);
  const count = volumeConfig.slices;

  for (let i = 1; i <= count; i += 1) {
    const k = (view.level + (view.volume * i) / count) * shear;
    const scale = 1 + k;

    if (
      tileAt(
        view.grid,
        (point.x + camera.x * k) / scale,
        (point.y + camera.y * k) / scale,
        view.tileSet,
      )
    ) {
      return true;
    }
  }

  return false;
}
