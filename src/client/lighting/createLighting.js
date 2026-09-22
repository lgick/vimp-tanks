import { Container, Sprite, Ticker } from 'pixi.js';
import { levelZ } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import {
  baseScale,
  cellOfPoint,
  cellsCoverPoint,
} from '../parts/map/tileGrid.js';
import {
  advance as advanceHole,
  apply as applyHole,
} from '../parts/map/holeOverlay.js';
import {
  lighting as lightingConfig,
  parallax as parallaxConfig,
} from '../../config/render.js';
import { offsetPoint } from '../parallax.js';
import LevelLightMap from './LevelLightMap.js';
import {
  EMISSIVE_BASE_Z,
  cellCenter,
  cellRuns,
  flashFactor,
  flicker,
  isOnScreen,
  projectLight,
} from './lightMath.js';

// цвет полумрака, если карта его не задала
const DEFAULT_AMBIENT = 0x3a4260;

// ключи текстур, которые принимает сервис (7.3)
const TEXTURE_KEYS = ['radial', 'cone', 'head'];

// Сервис пула зависимостей `lighting`: ночь, карты освещённости уровней,
// источники света и эмиссивный слой. Возвращается из `hooks.services(core)`
// (src/client/index.js), по экземпляру на ядро.
//
// Два вида состояния:
// - состояние КАРТЫ — оверлеи уровней, фонари (источники и головы), вклады
//   масок этажей. Живёт по ключу карты (`lightMath.mapKeyOf`), освобождается
//   `clear()` и при переключении ключа;
// - состояние СЕССИИ — зарегистрированные текстуры, источники `addLight`,
//   записи эмиссива. Переживает смену карты: танки и эффекты — не части
//   карты, движок уничтожает их отдельно, и снимают своё они сами.
// Область карт освещённости в мировых единицах: карта плюс запас на
// каждую сторону, равный её большей стороне, — при максимальном отдалении
// камеры за краем карты тоже полумрак
export function lightArea(size, step, scale) {
  const width = (size?.cols ?? 0) * step * scale.x;
  const height = (size?.rows ?? 0) * step * scale.y;
  const margin = Math.max(width, height);

  return {
    x: -margin,
    y: -margin,
    width: width + margin * 2,
    height: height + margin * 2,
  };
}

export function createLighting(cfg = lightingConfig, deps = {}) {
  const enabled = Boolean(cfg.enabled);
  const levelView = deps.levelView || null;
  const shear = deps.shear ?? parallaxConfig.shear;

  let stage = null;
  let renderer = null;

  // --- состояние сессии ---
  const textures = {};
  const lights = new Set();
  // sprite -> level
  const emissive = new Map();
  const flashes = [];

  // --- состояние карты ---
  let mapKey = null;
  // ключ -> число частей, взявших его
  const counts = new Map();
  let map = null;
  // level -> Map(owner -> cells)
  const masks = new Map();
  // то же для крыш (`game.roofs`): у них своя карта освещённости уровня
  const roofMasks = new Map();
  // level -> Map(owner -> { cells, volume }) — вершины объёмов
  const tops = new Map();
  let masksDirty = false;

  // ключ раскладки: трансформ сцены + тик (см. render)
  let layoutKey = null;

  const seeThroughCfg = () => levelView?.cfg || null;

  // --- эмиссив ---

  const emissiveContainer = level => {
    let container = map.emissive.get(level);

    if (!container) {
      container = new Container();
      container.label = `emissive-${level}`;
      container.zIndex = levelZ(EMISSIVE_BASE_Z, level);
      container.eventMode = 'none';
      map.emissive.set(level, container);
    }

    return container;
  };

  // головы фонарей: создаются, когда есть и карта, и текстура `head`
  const ensureLampHeads = () => {
    if (!map?.night || !textures.head || map.headsReady) {
      return;
    }

    map.headsReady = true;

    for (const lamp of map.lamps) {
      if (!lamp.head) {
        continue;
      }

      const sprite = new Sprite(textures.head.texture);

      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.tint = lamp.color;
      lamp.headSprite = sprite;
      emissiveContainer(lamp.level).addChild(sprite);
    }
  };

  // --- жизненный цикл карты ---

  const initMap = (lightingCfg, step, scale, size) => {
    const source = lightingCfg || {};
    const night = Boolean(source.night);
    const mapScale = baseScale(scale ?? 1);

    map = {
      night,
      ambient: source.ambient ?? DEFAULT_AMBIENT,
      step,
      scale: mapScale,
      area: lightArea(size, step, mapScale),
      lamps: [],
      headsReady: false,
      levels: new Map(),
      // level -> LevelLightMap крыш уровня
      roofLevels: new Map(),
      emissive: new Map(),
      // level -> Set('col,row') — для режима 'layer' дыры
      maskCells: new Map(),
      // level -> Set('col,row') — клетки крыш: дыра их карты открывается,
      // только когда крыша закрывает танк
      roofCells: new Map(),
    };

    if (!night) {
      return;
    }

    (source.lamps || []).forEach((lamp, index) => {
      const [col, row] = lamp.cell || [0, 0];
      const level = lamp.level || 0;
      const point = cellCenter(col, row, step, mapScale);

      map.lamps.push({
        kind: 'radial',
        level,
        x: point.x,
        y: point.y,
        z: level,
        radius: lamp.radius ?? 0,
        rotation: 0,
        color: lamp.color ?? 0xffffff,
        intensity: lamp.intensity ?? 1,
        flicker: lamp.flicker || 0,
        seed: index + 1,
        head: Boolean(lamp.head),
        headSprite: null,
      });
    });

    // уже принятые спрайты эмиссива возвращаются в контейнеры новой карты
    for (const [sprite, level] of emissive) {
      emissiveContainer(level).addChild(sprite);
    }

    ensureLampHeads();
    masksDirty = true;
    layoutKey = null;
  };

  // освобождает оверлеи, эмиссивные контейнеры и фонари карты: сначала со
  // сцены, потом destroy. Спрайты эмиссива сессии вынимаются, но не
  // уничтожаются — ими владеют части
  const releaseMapResources = () => {
    if (!map) {
      return;
    }

    for (const container of map.emissive.values()) {
      container.parent?.removeChild(container);
    }

    for (const levelMap of allLevelMaps()) {
      levelMap.overlay.parent?.removeChild(levelMap.overlay);
    }

    for (const container of map.emissive.values()) {
      for (const sprite of emissive.keys()) {
        if (sprite.parent === container) {
          container.removeChild(sprite);
        }
      }
    }

    for (const lamp of map.lamps) {
      if (lamp.headSprite) {
        lamp.headSprite.destroy({ texture: false, textureSource: false });
        lamp.headSprite = null;
      }
    }

    for (const container of map.emissive.values()) {
      container.destroy({ children: true });
    }

    for (const levelMap of allLevelMaps()) {
      levelMap.destroy();
    }

    map = null;
    layoutKey = null;
  };

  const clear = () => {
    releaseMapResources();
    masks.clear();
    roofMasks.clear();
    tops.clear();
    masksDirty = false;
    mapKey = null;
  };

  // --- маски этажей ---

  // все карты освещённости карты: обычные и крыш
  const allLevelMaps = () => [...map.levels.values(), ...map.roofLevels.values()];

  // объединение вкладов уровня без повторов: `[cells, keys]`, где `keys` —
  // Set('col,row'); клетки из `exclude` пропускаются
  const unionOf = (byOwner, exclude = null) => {
    const union = [];
    const keys = new Set();

    for (const cells of byOwner?.values() || []) {
      for (const cell of cells) {
        const key = `${cell[0]},${cell[1]}`;

        if (!keys.has(key) && !exclude?.has(key)) {
          keys.add(key);
          union.push(cell);
        }
      }
    }

    return [union, keys];
  };

  // карта уровня в реестре `registry`: пустой маске — уходит, иначе
  // создаётся при необходимости и получает маску
  const syncLevelMap = (registry, level, cells, roof) => {
    let levelMap = registry.get(level);

    if (cells.length === 0) {
      // вкладов уровня не осталось — оверлей уходит
      if (levelMap) {
        levelMap.destroy();
        registry.delete(level);
      }

      return;
    }

    if (!levelMap) {
      levelMap = new LevelLightMap({
        level,
        ambient: map.ambient,
        resolution: cfg.resolution,
        area: map.area,
        roof,
      });
      registry.set(level, levelMap);
    }

    levelMap.setMask(cellRuns(cells), map.step, map.scale);
  };

  // вершины объёмов уровня группами по высоте: `[{ volume, runs }]`
  const topGroupsOf = level => {
    const byVolume = new Map();

    for (const { cells, volume } of tops.get(level)?.values() || []) {
      if (!byVolume.has(volume)) {
        byVolume.set(volume, []);
      }

      byVolume.get(volume).push(...cells);
    }

    return [...byVolume].map(([volume, cells]) => ({
      volume,
      runs: cellRuns(cells),
    }));
  };

  const syncLevels = () => {
    const dirty = masksDirty;

    if (masksDirty) {
      masksDirty = false;

      const levels = new Set([
        ...masks.keys(),
        ...roofMasks.keys(),
        ...map.levels.keys(),
        ...map.roofLevels.keys(),
      ]);

      for (const level of levels) {
        if (level < 1) {
          continue;
        }

        // крыши — своя карта; обычная маска уровня их клеток не несёт,
        // иначе дыра обычной карты снимала бы затемнение и с крыш
        const [roofUnion, roofKeys] = unionOf(roofMasks.get(level));
        const [union, keys] = unionOf(masks.get(level), roofKeys);

        map.maskCells.set(level, keys);
        map.roofCells.set(level, roofKeys);
        syncLevelMap(map.levels, level, union, false);
        syncLevelMap(map.roofLevels, level, roofUnion, true);
      }
    }

    // уровень 0 на ночной карте есть всегда: полумрак нужен всей земле
    if (!map.levels.has(0)) {
      map.levels.set(
        0,
        new LevelLightMap({
          level: 0,
          ambient: map.ambient,
          resolution: cfg.resolution,
          area: map.area,
        }),
      );
    }

    // вершины объёмов — в обычную карту своего уровня
    if (dirty) {
      for (const levelMap of map.levels.values()) {
        levelMap.setTops(topGroupsOf(levelMap.level), map.step, map.scale);
      }
    }
  };

  const attachToStage = () => {
    for (const levelMap of allLevelMaps()) {
      if (levelMap.overlay.parent !== stage) {
        stage.addChild(levelMap.overlay);
      }
    }

    for (const container of map.emissive.values()) {
      if (container.parent !== stage) {
        stage.addChild(container);
      }
    }
  };

  // --- раскладка источников ---

  const itemOf = (light, camera, factor) => {
    const asset = light.kind === 'cone' ? textures.cone : textures.radial;

    if (!asset || !(light.intensity * factor > 0)) {
      return null;
    }

    const view = projectLight(light.x, light.y, light.z ?? light.level, camera, stage, shear);

    if (light.kind === 'cone') {
      const length = light.radius * view.scale;
      const halfWidth = length * (light.spread ?? 0.5);
      const reach = length * stage.scale.x;

      return {
        reach,
        view,
        texture: asset.texture,
        anchorX: asset.margin / asset.texture.width,
        anchorY: 0.5,
        scaleX: length / asset.length,
        scaleY: halfWidth / asset.halfWidth,
        rotation: light.rotation || 0,
        color: light.color,
        alpha: light.intensity * factor,
      };
    }

    const radius = light.radius * view.scale;

    return {
      reach: radius * stage.scale.x,
      view,
      texture: asset.texture,
      anchorX: 0.5,
      anchorY: 0.5,
      scaleX: (radius * 2) / asset.contentSize,
      scaleY: (radius * 2) / asset.contentSize,
      rotation: 0,
      color: light.color,
      alpha: light.intensity * factor,
    };
  };

  const layoutLights = (camera, screen, now) => {
    const perLevel = new Map();
    let count = 0;

    // источник с `levels` (танк на рампе) светит в карты нескольких уровней:
    // проекция одна (по `z`), лимит считается по добавленным спрайтам
    const push = (light, factor) => {
      const levels = (light.levels ?? [light.level]).filter(level =>
        map.levels.has(level),
      );

      if (count >= cfg.maxLights || levels.length === 0) {
        return;
      }

      const item = itemOf(light, camera, factor);

      if (
        !item ||
        !isOnScreen(
          item.view.screenX,
          item.view.screenY,
          item.reach,
          screen.width,
          screen.height,
        )
      ) {
        return;
      }

      item.x = item.view.x;
      item.y = item.view.y;

      for (const level of levels) {
        if (count >= cfg.maxLights) {
          return;
        }

        if (!perLevel.has(level)) {
          perLevel.set(level, []);
        }

        perLevel.get(level).push(item);
        count += 1;
      }
    };

    // вспышки — первыми: они короткие и заметнее всего
    for (let i = flashes.length - 1; i >= 0; i -= 1) {
      const flash = flashes[i];
      const factor = flashFactor(now - flash.start, flash.duration);

      if (factor <= 0) {
        flashes.splice(i, 1);
      } else {
        push(flash, factor);
      }
    }

    for (const light of lights) {
      push(light, 1);
    }

    for (const lamp of map.lamps) {
      push(lamp, flicker(lamp.seed, now, lamp.flicker));
    }

    // карта крыш уровня получает те же источники, что и обычная
    for (const levelMap of allLevelMaps()) {
      levelMap.place(camera, shear);
      levelMap.layout(perLevel.get(levelMap.level) || []);
    }
  };

  // --- прозрачность над игроком ---

  const updateHoles = (camera, stepped) => {
    const see = seeThroughCfg();

    if (!see) {
      return;
    }

    const dt = Ticker.shared.deltaMS / 1000;
    const rate = stepped ? Math.min(1, see.fadeRate * dt) : 0;
    // нарисованная точка игрока: крыша закрывает её, а не мировую
    const player = offsetPoint(levelView.x, levelView.y, camera, levelView.z * shear);

    for (const levelMap of allLevelMaps()) {
      if (levelMap.level < 1) {
        continue;
      }

      const below = levelView.level < levelMap.level;
      // крыша уступает, только когда закрывает танк (как её слой)
      const roofHides =
        levelMap.roof &&
        below &&
        cellsCoverPoint(
          map.roofCells.get(levelMap.level),
          map.step,
          map.scale,
          player,
          camera,
          [levelMap.level * shear],
          see.roofMargin ?? 0,
        );
      const overlay = levelMap.overlay;

      if (levelView.mode === 'layer') {
        let under = roofHides;

        if (!levelMap.roof) {
          const col = cellOfPoint(levelView.x, map.scale.x, map.step);
          const row = cellOfPoint(levelView.y, map.scale.y, map.step);

          under =
            below &&
            Boolean(map.maskCells.get(levelMap.level)?.has(`${col},${row}`));
        }

        const target = under ? see.layerAlpha : 1;

        overlay.alpha += (target - overlay.alpha) * rate;
        continue;
      }

      advanceHole(levelMap.hole, levelMap.roof ? roofHides : below, rate);
      applyHole(overlay, levelMap.hole, see, levelView, stage, camera);

      // фильтр дыры сам становится последним в цепочке и обязан класть
      // карту на сцену тем же умножением; без дыры — проходной фильтр
      if (levelMap.hole.attached) {
        levelMap.hole.filter.blendMode = 'multiply';
      } else if (overlay.filters?.[0] !== levelMap.filter) {
        overlay.filters = [levelMap.filter];
      }
    }
  };

  const updateEmissive = (camera, now) => {
    for (const lamp of map.lamps) {
      const sprite = lamp.headSprite;

      if (!sprite) {
        continue;
      }

      const view = projectLight(lamp.x, lamp.y, lamp.level, camera, stage, shear);

      sprite.position.set(view.x, view.y);
      sprite.scale.set(view.scale);
      sprite.alpha =
        (levelView ? levelView.alphaFor(lamp.level, view.x, view.y, 0) : 1) *
        flicker(lamp.seed, now, lamp.flicker);
    }

    // спрайты сессии уже в нарисованных координатах: `z = 0` не сдвигает
    // точку второй раз
    if (levelView) {
      for (const [sprite, level] of emissive) {
        sprite.alpha = levelView.alphaFor(level, sprite.x, sprite.y, 0);
      }
    }
  };

  const isNight = () => enabled && map?.night === true;

  return {
    get enabled() {
      return enabled;
    },

    // Ленивая привязка к сцене, как у levelView: зовут части игрового полотна
    attachStage(nextStage, nextRenderer) {
      if (!enabled || stage || !nextStage || !nextRenderer) {
        return;
      }

      stage = nextStage;
      renderer = nextRenderer;
      layoutKey = null;
      levelView?.attachStage(nextStage, nextRenderer);
    },

    // Каждая статическая часть. Первый вызов НОВОГО ключа инициализирует
    // карту (или переключает на неё), остальные только считают.
    // `size` — `{ cols, rows }` сетки карты: из него область карт
    // освещённости (`lightArea`)
    acquireMap(key, lightingCfg, step, scale, size) {
      if (!enabled) {
        return;
      }

      counts.set(key, (counts.get(key) || 0) + 1);

      if (key === mapKey) {
        return;
      }

      // переключение при живом старом ключе: освобождается только его
      // карта, вклады масок остаются у своих частей
      releaseMapResources();
      mapKey = key;
      initMap(lightingCfg, step, scale, size);
    },

    // Из destroy() части: снимает её вклад в маски; на нуле счётчика
    // ТЕКУЩЕГО ключа — clear(). Старый ключ на нуле просто забывается,
    // иначе clear() стёр бы уже переключённую карту
    releaseMap(key, owner) {
      if (!enabled) {
        return;
      }

      if (owner !== undefined) {
        for (const registry of [masks, roofMasks, tops]) {
          for (const byOwner of registry.values()) {
            if (byOwner.delete(owner)) {
              masksDirty = true;
            }
          }
        }
      }

      const count = counts.get(key);

      if (count === undefined) {
        return;
      }

      if (count > 1) {
        counts.set(key, count - 1);

        return;
      }

      counts.delete(key);

      if (key === mapKey) {
        clear();
      }
    },

    // вклад части в маску этажа уровня >= 1; маска — объединение вкладов.
    // `roof: true` — клетки крыш (`game.roofs`): они уходят в отдельную
    // карту уровня со своей дырой
    setLevelMask(level, cells, owner, { roof = false } = {}) {
      if (!enabled || !(level >= 1)) {
        return;
      }

      const registry = roof ? roofMasks : masks;

      if (!registry.has(level)) {
        registry.set(level, new Map());
      }

      if (cells && cells.length > 0) {
        registry.get(level).set(owner, cells);
      } else {
        registry.get(level).delete(owner);
      }

      masksDirty = true;
    },

    // вклад части в вершины объёмов уровня: клетки тайлов объёма и его
    // высота в уровнях. Снимается `releaseMap` вместе с масками
    setVolumeTops(level, cells, volume, owner) {
      if (!enabled || !(level >= 0)) {
        return;
      }

      if (!tops.has(level)) {
        tops.set(level, new Map());
      }

      if (cells && cells.length > 0 && volume > 0) {
        tops.get(level).set(owner, { cells, volume });
      } else {
        tops.get(level).delete(owner);
      }

      masksDirty = true;
    },

    // Частичная регистрация: переданные ключи перезаписываются. Спрайты
    // эмиссива со старой текстурой `head` получают свежую (перепечка после
    // потери контекста)
    registerTextures(patch) {
      if (!enabled || !patch) {
        return;
      }

      for (const key of TEXTURE_KEYS) {
        const asset = patch[key];

        if (!asset) {
          continue;
        }

        const previous = textures[key];

        textures[key] = asset;

        if (key === 'head' && previous && previous !== asset) {
          for (const sprite of emissive.keys()) {
            if (sprite.texture === previous.texture) {
              sprite.texture = asset.texture;
            }
          }

          for (const lamp of map?.lamps || []) {
            if (lamp.headSprite) {
              lamp.headSprite.texture = asset.texture;
            }
          }
        }
      }

      if (textures.head) {
        ensureLampHeads();
      }
    },

    // зарегистрированный ассет текстуры; null — ещё не передан
    texture(name) {
      return textures[name] || null;
    },

    addLight(light) {
      if (!enabled) {
        return null;
      }

      const record = {
        kind: 'radial',
        level: 0,
        x: 0,
        y: 0,
        radius: 0,
        rotation: 0,
        color: 0xffffff,
        intensity: 1,
        ...light,
      };

      lights.add(record);

      return record;
    },

    updateLight(handle, patch) {
      if (handle && lights.has(handle)) {
        Object.assign(handle, patch);
      }
    },

    removeLight(handle) {
      lights.delete(handle);
    },

    // короткая вспышка; без ночи или без текстуры `radial` — no-op
    flash(options) {
      if (!isNight() || !textures.radial) {
        return;
      }

      flashes.push({
        kind: 'radial',
        level: 0,
        color: 0xffffff,
        intensity: 1,
        ...options,
        start: Ticker.shared.lastTime,
      });
    },

    // false — ночи нет: спрайт остаётся у вызывающей части
    addEmissive(sprite, level) {
      if (!isNight() || !sprite) {
        return false;
      }

      const current = emissive.get(sprite);

      if (current !== undefined && sprite.parent) {
        sprite.parent.removeChild(sprite);
      }

      emissive.set(sprite, level || 0);
      emissiveContainer(level || 0).addChild(sprite);

      return true;
    },

    removeEmissive(sprite) {
      if (!emissive.has(sprite)) {
        return;
      }

      emissive.delete(sprite);

      for (const container of map?.emissive.values() || []) {
        if (sprite.parent === container) {
          container.removeChild(sprite);
        }
      }
    },

    isNight,

    // Зовут части из onRender. Раскладка — один раз на трансформ сцены в
    // тике: за тик полотно рисуется несколько раз, и каждая отрисовка после
    // смены камеры получает свежую проекцию, а повторные вызовы той же
    // отрисовки ничего не делают. Сглаживание дыры шагает раз на тик
    render() {
      if (!isNight() || !stage || !renderer) {
        return;
      }

      const camera = levelView ? levelView.camera() : cameraCenter(stage, renderer);
      const screen = renderer.screen;

      if (!camera || !screen) {
        return;
      }

      const tick = Ticker.shared.lastTime;
      const key = layoutKey;

      if (
        key !== null &&
        key.tick === tick &&
        key.x === stage.position.x &&
        key.y === stage.position.y &&
        key.scaleX === stage.scale.x &&
        key.scaleY === stage.scale.y &&
        key.width === screen.width &&
        key.height === screen.height &&
        !masksDirty
      ) {
        return;
      }

      const stepped = key === null || key.tick !== tick;

      layoutKey = {
        tick,
        x: stage.position.x,
        y: stage.position.y,
        scaleX: stage.scale.x,
        scaleY: stage.scale.y,
        width: screen.width,
        height: screen.height,
      };

      syncLevels();
      ensureLampHeads();
      attachToStage();
      layoutLights(camera, screen, tick);

      if (levelView) {
        updateHoles(camera, stepped);
      }

      updateEmissive(camera, tick);
    },

    // внутренний, но открыт для тестов и восстановления
    clear,
  };
}
