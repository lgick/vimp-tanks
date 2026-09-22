import { Ticker } from 'pixi.js';
import { offsetPoint } from '../../parallax.js';
import { advance as advanceHole, apply as applyHole } from './holeOverlay.js';
import { parallax as parallaxConfig } from '../../../config/render.js';
import { coversPoint, tileAt } from './tileGrid.js';

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
//   level               уровень слоя
//   grid                грид тайлов (`tileGrid`)
//   tileSet, floorSet   наборы тайлов слоя и тайлов пола
//   roof                слой — крыша (`game.roofs`)

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

  // Крыша уступает видимость, только когда закрывает сам танк: иначе
  // дыра открывала её всякий раз, когда игрок ниже, и сквозь неё
  // проступала верхушка стены без неона своего уровня
  const roofHides = view.roof
    ? levelView.level < view.level && roofHidesPlayer(view, cfg, camera)
    : null;

  // путь отхода: гаснет весь слой целиком (прежнее поведение)
  if (levelView.mode === 'layer') {
    const under = view.roof
      ? roofHides
      : levelView.level < view.level &&
        tileAt(view.grid, levelView.x, levelView.y, view.floorSet);
    const target = under ? cfg.layerAlpha : 1;

    container.alpha += (target - container.alpha) * rate;

    return;
  }

  // режим 'hole': проверки пола нет — дыра ездит за игроком, и её край
  // сам показывает, где кончается плита
  const above = view.roof ? roofHides : levelView.level < view.level;

  advanceHole(view.hole, above, rate);
  applyHole(container, view.hole, cfg, levelView, view.stage, camera);
}

// Перекрыватель гаснет, только когда его уровень НАД игроком — вместе со
// своим слоем (перила моста обязаны исчезать вместе с плитой). Объём
// СВОЕГО уровня не гаснет никогда: на скорости упреждение камеры уводит
// её за грань стены, верх стены нависает над танком, и дыра гасила объём —
// стена становилась плоской. Танк у стены на секунду-другую может быть
// частично закрыт её верхом, пока камера его не догонит.
function updateOccluderSeeThrough(view, cfg, rate, camera) {
  const { levelView, occluder } = view;
  const above = view.level > levelView.level;

  if (levelView.mode === 'layer') {
    // путь отхода: чужой уровень гаснет целиком, свой не гаснет вовсе
    const alpha = above ? cfg.layerAlpha : 1;

    occluder.alpha += (alpha - occluder.alpha) * rate;

    return;
  }

  advanceHole(view.occluderHole, above, rate);
  applyHole(occluder, view.occluderHole, cfg, levelView, view.stage, camera);
}

// нарисованная точка локального игрока: он смещён проекцией на свою высоту
function playerPoint(view, camera) {
  const player = view.levelView;

  return offsetPoint(player.x, player.y, camera, player.z * parallaxConfig.shear);
}

// Накрывает ли крыша нарисованную точку игрока (с запасом `roofMargin`):
// крыша плоская и рисуется на высоте своего уровня
function roofHidesPlayer(view, cfg, camera) {
  if (!camera) {
    return false;
  }

  return coversPoint(
    view.grid,
    view.tileSet,
    playerPoint(view, camera),
    camera,
    [view.level * parallaxConfig.shear],
    cfg.roofMargin ?? 0,
  );
}
