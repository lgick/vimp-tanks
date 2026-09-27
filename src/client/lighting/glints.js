import { Ticker } from 'pixi.js';
import {
  flashFactor,
  flicker,
  lightStrength,
  queryLightGrid,
  selectLights,
} from './lightMath.js';

// Засветы сервиса `lighting`: какие источники светят в точку. `lights` и
// `flashes` — источники сессии сервиса (живые коллекции), `getMap()` —
// текущее состояние карты (сетка фонарей `lampGrid`), `reachesPoint` —
// окклюзия фар (`occlusion.js`)
export function createGlintQuery({ getMap, lights, flashes, cfg, reachesPoint }) {
  // бюджет засветов на тик: `lightsAt` с ответом — не больше `maxLights`
  let glintTick = null;
  let glintCount = 0;

  // источники, светящие в точку уровня `level`: фонари (из сетки), фары
  // танков (конусы сессии) и вспышки — `[{ light, factor }]`. Свет под
  // корпусом (радиальные источники сессии) засвета не даёт
  const candidatesAt = (x, y, level, exclude, now) => {
    const map = getMap();
    const candidates = [];
    const onLevel = light => (light.levels ?? [light.level ?? 0]).includes(level);

    for (const lamp of queryLightGrid(map.lampGrid, x, y)) {
      if (lamp.level === level) {
        candidates.push({
          light: lamp,
          factor: flicker(lamp.seed, now, lamp.flicker),
        });
      }
    }

    for (const light of lights) {
      // стены — после дешёвой проверки дальности и угла конуса
      if (
        light.kind === 'cone' &&
        !exclude?.includes(light) &&
        onLevel(light) &&
        lightStrength(light, x, y) > 0 &&
        reachesPoint(light, x, y)
      ) {
        candidates.push({ light, factor: 1 });
      }
    }

    for (const flash of flashes) {
      const factor = flashFactor(now - flash.start, flash.duration);

      if (factor > 0 && onLevel(flash)) {
        candidates.push({ light: flash, factor });
      }
    }

    return candidates;
  };

  // Засвет: до `limit` сильнейших источников в мировой точке уровня
  // `level` — `[{ light, strength, angle, color }]`, `angle` — от точки НА
  // источник. `exclude` — свои источники (фары самого танка). После
  // `maxLights` ответов за тик — пусто (бюджет спрайтов)
  const lightsAt = (x, y, level, limit = 1, exclude = null) => {
    if (!(limit > 0)) {
      return [];
    }

    const now = Ticker.shared.lastTime;

    if (glintTick !== now) {
      glintTick = now;
      glintCount = 0;
    }

    if (glintCount >= cfg.maxLights) {
      return [];
    }

    const hits = selectLights(
      candidatesAt(x, y, level, exclude, now),
      x,
      y,
      limit,
    );

    if (hits.length) {
      glintCount += 1;
    }

    return hits;
  };

  return { lightsAt, candidatesAt };
}
