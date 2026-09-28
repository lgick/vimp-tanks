import { volume as volumeConfig } from '../../config/render.js';
import { rampLight } from './lightGeometry.js';
import { frameOf } from './occlusion.js';

// Свет на клиньях рамп сервиса `lighting`: меши `rampLight` на источник и
// полосу (кеш по вееру) и уровни подножия, чьи карты получают свет уровня
// вершины. `getMap()` — текущее состояние карты сервиса, `textures` —
// зарегистрированные текстуры сервиса (живой объект)
export function createRampLights({ getMap, textures }) {
  // веер-прямоугольник текстуры источника без окклюзии: источник ->
  // { key, fan } (`quadFanOf`)
  const quads = new WeakMap();
  // свет на клиньях: массив точек веера -> Map(полоса -> меш `rampLight`
  // или null). Веер фары у стены и прямоугольник фонаря живут, пока
  // источник стоит, — и меши вместе с ними
  const rampMeshes = new WeakMap();

  // Веер-прямоугольник текстуры источника (вершина и четыре угла,
  // замкнут) — свету на клине нужен веер и там, где окклюзии нет: фонарь,
  // вспышка, фара без стен рядом
  const quadFanOf = (light, asset) => {
    const key = `${light.kind},${light.x},${light.y},${light.rotation},${light.radius},${light.spread}`;
    const cached = quads.get(light);

    if (cached && cached.key === key && cached.texture === asset.texture) {
      return cached.fan;
    }

    const frame = frameOf(light, asset);
    const cos = Math.cos(frame.rotation);
    const sin = Math.sin(frame.rotation);
    const back = -frame.margin * frame.sx;
    const front = (frame.width - frame.margin) * frame.sx;
    const side = (frame.height / 2) * frame.sy;
    const points = new Float32Array(10);

    points[0] = frame.x;
    points[1] = frame.y;

    [
      [back, -side],
      [front, -side],
      [front, side],
      [back, side],
    ].forEach(([along, across], i) => {
      points[(i + 1) * 2] = frame.x + along * cos - across * sin;
      points[(i + 1) * 2 + 1] = frame.y + along * sin + across * cos;
    });

    const fan = { points, closed: true, frame };

    quads.set(light, { key, texture: asset.texture, fan });

    return fan;
  };

  // Свет источника на клиньях `lanes` в проекции клина — в `target`
  // (level подножия -> items). Веер — окклюзии фары (`item.rampFan`) или
  // прямоугольник текстуры. Возвращает, задел ли свет хоть один клин
  const pushRampLights = (target, level, lanes, light, item, alpha) => {
    if (!lanes?.length) {
      return false;
    }

    const map = getMap();
    const asset = light.kind === 'cone' ? textures.cone : textures.radial;
    const fan = item.rampFan ?? quadFanOf(light, asset);
    let byLane = rampMeshes.get(fan.points);

    if (!byLane) {
      byLane = new Map();
      rampMeshes.set(fan.points, byLane);
    }

    let added = false;

    for (const lane of lanes) {
      if (!byLane.has(lane)) {
        byLane.set(
          lane,
          rampLight({
            points: fan.points,
            closed: fan.closed,
            lane,
            frame: fan.frame,
            cellW: map.cellW,
            cellH: map.cellH,
            segmentsPerCell: volumeConfig.rampSegments,
          }),
        );
      }

      const ramp = byLane.get(lane);

      if (ramp) {
        if (!target.has(level)) {
          target.set(level, []);
        }

        target.get(level).push({
          ramp,
          texture: item.texture,
          color: item.color,
          alpha,
        });
        added = true;
      }
    }

    return added;
  };

  // уровень вершины -> уровни подножия: их карты кладут источники вершины
  // в `rampLights`
  const targets = () => {
    const rampTargets = new Map();

    for (const levelMap of getMap().levels.values()) {
      for (const top of levelMap.rampLevels()) {
        if (!rampTargets.has(top)) {
          rampTargets.set(top, []);
        }

        rampTargets.get(top).push(levelMap.level);
      }
    }

    return rampTargets;
  };

  return { push: pushRampLights, targets };
}
