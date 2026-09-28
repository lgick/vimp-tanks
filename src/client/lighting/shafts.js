import { offsetPoint } from '../parallax.js';
import {
  flicker,
  isOnScreen,
  projectLight,
  shadowWedge,
  shaftSway,
} from './lightMath.js';
import { hasLevelMap } from './LevelLightMap.js';

// наибольшее покачивание лучей фонаря, рад
const SHAFT_SWAY = 0.08;

// клинья теней предметов уровня фонаря в его лучах: ближайшие
// `maxShadowCasters` в радиусе лучей, в нарисованных координатах
export function shadowsOf({ lamp, view, reach, camera, shaftsCfg, casters, shear }) {
  if (!shaftsCfg.shadows || !(shaftsCfg.maxShadowCasters > 0)) {
    return [];
  }

  const worldReach = lamp.radius * shaftsCfg.length;
  const near = [];

  for (const caster of casters.values()) {
    const distance = Math.hypot(caster.x - lamp.x, caster.y - lamp.y);

    if (caster.level === lamp.level && distance < worldReach) {
      near.push({ caster, distance });
    }
  }

  near.sort((a, b) => a.distance - b.distance);

  const polygons = [];

  for (const { caster } of near.slice(0, shaftsCfg.maxShadowCasters)) {
    const k = (caster.z ?? caster.level) * shear;
    const point = offsetPoint(caster.x, caster.y, camera, k);
    const wedge = shadowWedge(
      view.x,
      view.y,
      point.x,
      point.y,
      caster.radius * (1 + k),
      reach,
    );

    if (wedge) {
      polygons.push(wedge);
    }
  }

  return polygons;
}

// Лучи в воздухе вокруг голов фонарей карты `map` сервиса `lighting`:
// level -> items для `LevelLightMap.layoutShafts`. `asset` — текстура
// `shaft`, `casters` — предметы-тени сессии (owner -> { x, y, z, level,
// radius })
export function layoutShafts({
  map,
  casters,
  cfg,
  asset,
  camera,
  screen,
  now,
  stage,
  shear,
}) {
  const perLevel = new Map();
  const shaftsCfg = cfg.shafts;

  if (!shaftsCfg?.enabled || !asset) {
    return perLevel;
  }

  let count = 0;

  for (const lamp of map.lamps) {
    // у уровня фонаря нет карты освещённости — ни обычной, ни крыш
    if (!lamp.head || !hasLevelMap(map, lamp.level)) {
      continue;
    }

    if (count >= cfg.maxLights) {
      break;
    }

    const view = projectLight(lamp.x, lamp.y, lamp.level, camera, stage, shear);
    const reach = lamp.radius * shaftsCfg.length * view.scale;

    if (
      !(reach > 0) ||
      !isOnScreen(
        view.screenX,
        view.screenY,
        reach * stage.scale.x,
        screen.width,
        screen.height,
      )
    ) {
      continue;
    }

    if (!perLevel.has(lamp.level)) {
      perLevel.set(lamp.level, []);
    }

    perLevel.get(lamp.level).push({
      texture: asset.texture,
      x: view.x,
      y: view.y,
      scale: (reach * 2) / asset.contentSize,
      rotation: shaftSway(lamp.seed, now, SHAFT_SWAY),
      color: lamp.color,
      alpha:
        shaftsCfg.intensity *
        lamp.intensity *
        flicker(lamp.seed, now, lamp.flicker),
      shadows: shadowsOf({
        lamp,
        view,
        reach,
        camera,
        shaftsCfg,
        casters,
        shear,
      }),
    });
    count += 1;
  }

  return perLevel;
}
