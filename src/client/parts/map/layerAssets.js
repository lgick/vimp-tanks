import { Container, Sprite } from 'pixi.js';
import { levelZ } from '../../levelZ.js';
import { applyParallax } from '../../parallax.js';
import { bakeTileLayer } from '../bakeTileLayer.js';
import { buildRampLanes } from '../rampLanes.js';
import { cellOfEdge } from './tileGrid.js';
import { buildVolumeSlices, buildRampMeshes } from './extrusion.js';
import {
  parallax as parallaxConfig,
  volume as volumeConfig,
} from '../../../config/render.js';

// Сборка статического слоя карты: запекание тайл-листа, объём, клин рампы
// и полосы рамп в клетках грида. Отдельный модуль, потому что у слоя
// (`MapLayer.js`) это отдельная зона ответственности со своими тремя
// `await` — и после каждого парт может быть уже уничтожен.
//
// Модуль НИЧЕГО не знает о парте: на вход идёт описание слоя (`spec`), на
// выход — готовые объекты, а раскладывает их по своим полям сам слой.
// Полей парта здесь нет ни одного: иначе переименование приватного поля
// молча ломало бы соседний файл.
//
// `spec` — это:
//   container        контейнер парта: в него кладутся слой и клин
//   baseTexture      промис тайл-листа, `spriteSheetData` его разметка
//   map, tiles, step грид слоя, имена его тайлов и размер тайла
//   renderer         рендерер полотна (нужен запеканию)
//   level, layer     уровень слоя и его базовый zIndex
//   volume           высота слоя в уровнях (0 — плоский)
//   ramps            конфиги рамп ЭТОГО слоя, `rampRuns` сервис прогонов
//   baseScale        базовый масштаб карты (`tileGrid`)
//   parallaxK        сдвиг слоя по высоте его уровня
//   extruding        нужна ли экструзия вообще
//   assetUrl         только для сообщения об ошибке
//   isAborted()      парт уже уничтожен — бросать работу

// Базовый zIndex контейнера-перекрывателя: объём слоя рисуется НАД
// динамикой СВОЕГО уровня, иначе танк «наезжает» на стену вместо того,
// чтобы уйти за неё (экструзия идёт ОТ центра камеры, то есть накрывает
// область за стеной — ровно там танк и стоит). 5 — выше танка (3), дыма
// (4), бомб и эффектов (2) и следов (1), и заведомо меньше шага уровней
// (`parallax.levelZStride`): слой уровня N + 1 по-прежнему выше всего,
// что принадлежит уровню N
const OCCLUDER_BASE_Z = 5;

const NOTHING = {
  mapSprite: null,
  occluder: null,
  slices: [],
  rampTexture: null,
};

// Освобождение всего, что успела собрать сборка уничтоженному парту.
// Владение то же, что и в `MapLayer.destroy`: запечённую текстуру слоя
// делят спрайт и срезы объёма — отдаёт её спрайт; текстуру клина делят
// его меши — она своя и отдаётся отдельно
function disposeAssets({
  mapSprite,
  bakedTexture,
  occluder,
  slices,
  rampTexture,
}) {
  for (const slice of slices) {
    slice.target.parent?.removeChild(slice.target);
    slice.target.destroy({ texture: false, textureSource: false });
  }

  occluder?.destroy({ children: true, texture: false, textureSource: false });

  if (rampTexture) {
    rampTexture.destroy(true);
  }

  // запечённая текстура отдаётся ОТДЕЛЬНО от спрайта, а не через
  // `texture: true`: спрайт уже лежал в контейнере парта, и `super.destroy`
  // парта (`children: true`) успел уничтожить его сам, обнулив `_texture`
  // — второй destroy с `texture: true` упал бы на `null.destroy()`, а
  // источник так и остался бы жив
  if (mapSprite) {
    mapSprite.parent?.removeChild(mapSprite);
    mapSprite.destroy({ texture: false, textureSource: false });
  }

  bakedTexture?.destroy(true);
}

export async function buildLayerAssets(spec) {
  try {
    const baseTexture = await spec.baseTexture;

    // парт мог быть уничтожен, пока грузился ассет: смена карты сносит
    // старые парты в том же тике, в котором создаёт новые
    if (spec.isAborted()) {
      return NOTHING;
    }

    const bakedTexture = await bakeTileLayer({
      baseTexture,
      spriteSheetData: spec.spriteSheetData,
      map: spec.map,
      tiles: spec.tiles,
      step: spec.step,
      renderer: spec.renderer,
    });

    // повторно: запекание — второй await, и текстура уже создана, поэтому
    // уничтоженному парту её нужно не бросить, а освободить
    if (spec.isAborted()) {
      bakedTexture.destroy(true);

      return NOTHING;
    }

    // один большой спрайт из "запеченной" текстуры
    const mapSprite = new Sprite(bakedTexture);

    applyParallax(mapSprite, null, spec.parallaxK, spec.baseScale);
    spec.container.addChild(mapSprite);

    if (!spec.extruding) {
      return { ...NOTHING, mapSprite };
    }

    const extrusion = await buildExtrusion(spec, baseTexture, bakedTexture);
    const assets = { mapSprite, ...extrusion };

    // экструзия — это ещё один await (запекание клина), и парт мог уйти в
    // нём. Освобождать собранное обязан ЭТОТ вызов: слой уже прошёл свой
    // `destroy()`, поля ему присвоятся мёртвому и текстуру клина не
    // отдаст никто
    if (spec.isAborted()) {
      disposeAssets({ ...assets, bakedTexture });

      return NOTHING;
    }

    return assets;
  } catch (error) {
    console.error(
      `Failed to create static map with asset ${spec.assetUrl}:`,
      error,
    );

    return NOTHING;
  }
}

// Экструзия слоя: объём (`volume`) — K копий ТОЙ ЖЕ запечённой картинки,
// каждая следующая сдвинута от центра камеры сильнее предыдущей; клин
// рампы — по мешу на прогон, наклонная плоскость с непрерывно растущей
// высотой (`buildRampMeshes`, src/client/parts/map/extrusion.js).
//
// Срезы ОБЪЁМА уходят в контейнер-перекрыватель (сиблинг парта на сцене):
// им нужен zIndex выше динамики своего уровня, иначе танк рисуется поверх
// стены, за которой стоит. Прозрачность и «дыра» у перекрывателя свои —
// считаются той же формулой, что у слоя (`layerSeeThrough.js`).
//
// Клин рампы, наоборот, остаётся ребёнком парта: танк, поднимающийся по
// горке, обязан рисоваться ПОВЕРХ её поверхности
async function buildExtrusion(spec, baseTexture, bakedTexture) {
  const count = volumeConfig.slices;
  const shear = parallaxConfig.shear;
  const built = [];
  let occluder = null;
  let rampTexture = null;

  if (spec.volume > 0) {
    occluder = new Container();
    occluder.zIndex = levelZ(
      Math.max(spec.layer, OCCLUDER_BASE_Z),
      spec.level,
    );

    built.push(
      ...buildVolumeSlices({
        bakedTexture,
        level: spec.level,
        volume: spec.volume,
        shear,
        count,
        sideTint: volumeConfig.sideTint,
      }),
    );
  }

  const runs = rampLanes(spec);

  if (runs.length) {
    rampTexture = await bakeTileLayer({
      baseTexture,
      spriteSheetData: spec.spriteSheetData,
      map: spec.map,
      tiles: spec.ramps.map(ramp => ramp.tile),
      step: spec.step,
      renderer: spec.renderer,
    });

    // третий await: парт мог уйти, пока пеклась текстура клина. Работа
    // бросается, а освобождение уходит одним местом наверх
    // (`disposeAssets` в `buildLayerAssets`)
    if (spec.isAborted()) {
      return { occluder, slices: built, rampTexture };
    }

    built.push(
      ...buildRampMeshes({
        runs,
        texture: rampTexture,
        step: spec.step,
        shear,
        baseScale: spec.baseScale,
        segments: volumeConfig.rampSegments,
        sideTint: volumeConfig.sideTint,
      }),
    );
  }

  if (spec.isAborted()) {
    return { occluder, slices: built, rampTexture };
  }

  // порядок отрисовки — по высоте: выше срез, позже он нарисован. Плоский
  // слой остаётся основанием и уже лежит первым
  built.sort((a, b) => a.k - b.k);

  for (const slice of built) {
    // меш клина уже стоит в мировых вершинах: до первого кадра он лежит
    // без сдвига, как и слой без камеры
    if (!slice.base) {
      applyParallax(slice.target, null, slice.k, spec.baseScale);
    }

    (slice.occluder ? occluder : spec.container).addChild(slice.target);
  }

  return { occluder, slices: built, rampTexture };
}

// Полосы рамп ЭТОГО слоя в клетках его грида. Прогоны приходят из ядра
// в МИРОВЫХ единицах (`tile_size == step * scale`), а грид слоя не
// масштабирован. Перевод здесь по ГРАНИЦЕ клетки (`cellOfEdge`), а не по
// точке внутри неё (`cellOfPoint` у `tileAt`): границы прогона идут по
// кромкам тайлов, и пол вместо округления давал бы клетку левее.
//
// Уровень задаёт сервис (`forLevel`), а слой среди них берёт только свои
// горки: у карты слой земли и слой стен делят один грид, и клин рисует
// тот из них, чьи тайлы рампы он и рисует. Тайла в прогоне нет — рампы
// сличаются по паре уровней «подножие/вершина»
export function rampLanes(spec) {
  if (!spec.ramps?.length || !spec.rampRuns) {
    return [];
  }

  const owned = new Set(spec.ramps.map(ramp => `${ramp.from}:${ramp.to}`));
  const runs = spec.rampRuns
    .forLevel(spec.level)
    .filter(run => owned.has(`${run.from}:${run.to}`));
  const toCell = (world, axis) =>
    cellOfEdge(
      world,
      axis === 0 ? spec.baseScale.x : spec.baseScale.y,
      spec.step,
    );

  return buildRampLanes(runs, toCell);
}
