import { Graphics, Container, Rectangle } from 'pixi.js';
import { scaleTint } from '../tilt.js';
import { drawTankBody, drawTankGun, TANK_ART } from './tankTexture.js';
import { tankModel as tankModelConfig } from '../../config/render.js';

// Атлас граней 3D-модели танка (`src/client/tank3d/`, plan/tank-3d/): один
// на команду. Верх корпуса и башни — тот же рисунок, что у плоской текстуры
// (`drawTankBody`/`drawTankGun`): модель проецирует на него свои верхи и
// скаты по (u, v). Отвесные бока — свои полосы: борт гусеницы с катками,
// ствол, дульный тормоз. Светотень атласа симметрична — направленный свет
// даёт `faceShade` по нормали грани.
//
// Области — в пикселях атласа; у планарных (`body`, `gun`) есть
// `originX/originY` — куда в атласе попадает точка (0, 0) модели.

// зазор между областями: без него линейная выборка на кромке грани тянет
// соседнюю область
const PAD = 2;

// отвесный борт гусеницы: тёмная лента, катки и ленивец
function drawTrackSide(g, { x, y, w, h }) {
  g.rect(x, y, w, h).fill(0x2e2e2e);
  // верхняя ветвь ленты
  g.rect(x, y, w, 1).fill(0x3c3c3c);

  const radius = Math.max(1, h * 0.38);

  for (let cx = x + radius + 1; cx < x + w - radius; cx += radius * 2.6) {
    g.circle(cx, y + h * 0.58, radius).fill(0x4a4a4a);
    g.circle(cx, y + h * 0.58, radius * 0.4).fill(0x222222);
  }
}

// цилиндр сбоку: цвет с затемнёнными кромками (симметрично)
function drawCylinderSide(g, { x, y, w, h }, color) {
  g.rect(x, y, w, h).fill(scaleTint(color, 0.75));

  if (h > 2) {
    g.rect(x, y + 1, w, h - 2).fill(color);
  }
}

/**
 * @param {object} params
 * @param {{ teamId1: number, teamId2: number }} params.colors
 * @param {object} renderer
 * @param {object} [config]  `tankModel` из src/config/render.js
 * @returns {{ liveTeamId1: object, liveTeamId2: object, destroyed: object }}
 *   у каждого
 *   `{ texture, width, height, regions }`
 */
export default function tankModelTexture(
  params,
  renderer,
  config = tankModelConfig,
) {
  const { colors } = params;

  // `burnt` — остов: тот же рисунок под тёмной вуалью с пятнами копоти
  const bake = (color, burnt = false) => {
    // габарит башни со стволом — по её же рисунку
    const probe = new Graphics();

    drawTankGun(probe, color);

    const gunBounds = probe.getBounds();

    probe.destroy(true);

    const gunW = Math.ceil(gunBounds.width);
    const gunH = Math.ceil(gunBounds.height);

    const body = {
      x: PAD,
      y: PAD,
      w: TANK_ART.width,
      h: TANK_ART.height,
      originX: PAD + TANK_ART.width / 2,
      originY: PAD + TANK_ART.height / 2,
    };
    const gun = {
      x: body.x + body.w + PAD,
      y: PAD,
      w: gunW,
      h: gunH,
      originX: body.x + body.w + PAD - gunBounds.x,
      originY: PAD - gunBounds.y,
    };

    const rowY = PAD + Math.max(body.h, gun.h) + PAD;
    const trackSide = {
      x: PAD,
      y: rowY,
      w: TANK_ART.width,
      h: config.trackHeight,
    };
    const barrelSide = {
      x: trackSide.x + trackSide.w + PAD,
      y: rowY,
      w: 22,
      h: config.barrelRadius * 2,
    };
    const brakeSide = {
      x: barrelSide.x + barrelSide.w + PAD,
      y: rowY,
      w: 8,
      h: config.brakeRadius * 2,
    };
    const bottom = { x: brakeSide.x + brakeSide.w + PAD, y: rowY, w: 4, h: 4 };

    const width = Math.max(gun.x + gun.w, bottom.x + bottom.w) + PAD;
    const height =
      rowY + Math.max(trackSide.h, barrelSide.h, brakeSide.h, bottom.h) + PAD;

    const atlas = new Container();
    const bodyArt = new Graphics();
    const gunArt = new Graphics();
    const strips = new Graphics();

    drawTankBody(bodyArt);
    bodyArt.position.set(body.originX, body.originY);
    drawTankGun(gunArt, color);
    gunArt.position.set(gun.originX, gun.originY);

    drawTrackSide(strips, trackSide);
    drawCylinderSide(strips, barrelSide, color);
    drawCylinderSide(strips, brakeSide, scaleTint(color, 0.7));
    strips.rect(bottom.x, bottom.y, bottom.w, bottom.h).fill(0x1a1a1a);

    atlas.addChild(bodyArt, gunArt, strips);

    if (burnt) {
      const soot = new Graphics();

      for (const region of [body, gun, trackSide, barrelSide, brakeSide]) {
        soot.rect(region.x, region.y, region.w, region.h).fill({
          color: 0x0c0a08,
          alpha: 0.62,
        });
      }

      // пятна копоти и прогаров на палубе и башне
      soot.circle(body.originX + 4, body.originY + 2, 6).fill({
        color: 0x000000,
        alpha: 0.5,
      });
      soot.circle(body.originX - 9, body.originY - 4, 3).fill({
        color: 0x000000,
        alpha: 0.5,
      });
      soot.circle(gun.originX - 2, gun.originY + 1, 4).fill({
        color: 0x000000,
        alpha: 0.5,
      });

      atlas.addChild(soot);
    }

    const texture = renderer.generateTexture({
      target: atlas,
      frame: new Rectangle(0, 0, width, height),
    });

    atlas.destroy({ children: true });

    return {
      texture,
      width,
      height,
      regions: { body, gun, trackSide, barrelSide, brakeSide, bottom },
    };
  };

  return {
    liveTeamId1: bake(colors.teamId1),
    liveTeamId2: bake(colors.teamId2),
    // остов без цвета команды: обгоревший металл
    destroyed: bake(0x3a3a3a, true),
  };
}
