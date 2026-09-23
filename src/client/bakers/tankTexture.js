import { Graphics, Container, Rectangle } from 'pixi.js';
import { scaleTint } from '../tilt.js';

// Нормаль в цвет карты нормалей: xyz ∈ [−1, 1] → канал 0..255. Оси —
// оси ТЕКСТУРЫ: `+x` — нос, `+y` — экранный низ квада, `+z` — к камере.
// Вектор нормируется здесь, поэтому скат задаётся просто наклоном,
// например `(−1, 0, 1)` — грань под 45° к корме
export function normalColor(x, y, z) {
  const len = Math.hypot(x, y, z) || 1;
  const channel = value => Math.round(((value / len) * 0.5 + 0.5) * 255);

  return (channel(x) << 16) | (channel(y) << 8) | channel(z);
}

// плоский верх: нормаль смотрит прямо в камеру
export const FLAT_NORMAL = normalColor(0, 0, 1);

// Рамка фаски: четыре трапеции по краям прямоугольника, у каждой своя
// заливка. Одна функция для цветной текстуры и для карты нормалей —
// так фаски совпадают пиксель в пиксель
function bevelFrame(g, { x, y, w, h }, { l, r, t, b }, fills) {
  g.poly([x, y, x + w, y, x + w - r, y + t, x + l, y + t]).fill(fills.t);
  g.poly([x, y + h, x + w, y + h, x + w - r, y + h - b, x + l, y + h - b]).fill(
    fills.b,
  );
  g.poly([x, y, x + l, y + t, x + l, y + h - b, x, y + h]).fill(fills.l);
  g.poly([x + w, y, x + w - r, y + t, x + w - r, y + h - b, x + w, y + h]).fill(
    fills.r,
  );
}

// Кольцо фаски выпуклого многоугольника с центром в начале координат:
// трапеция на каждое ребро между контуром и его копией, сжатой в `inner`
// раз. `fill(nx, ny)` получает внешнюю нормаль ребра в плоскости
function bevelRing(g, points, inner, fill) {
  const count = points.length / 2;

  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    const ax = points[i * 2];
    const ay = points[i * 2 + 1];
    const bx = points[j * 2];
    const by = points[j * 2 + 1];
    let nx = by - ay;
    let ny = -(bx - ax);

    // внешняя сторона — та, что смотрит от центра
    if (nx * (ax + bx) + ny * (ay + by) < 0) {
      nx = -nx;
      ny = -ny;
    }

    g.poly([
      ax,
      ay,
      bx,
      by,
      bx * inner,
      by * inner,
      ax * inner,
      ay * inner,
    ]).fill(fill(nx, ny));
  }
}

// создает набор текстур для танка
// (нормальное состояние для команд и уничтоженное)
// params.colors - Объект с цветами для команд
// renderer - PIXI рендерер
//
// К каждой цветной текстуре запекается парная КАРТА НОРМАЛЕЙ (`bodyNormal`,
// `gunNormal`, `destroyedNormal`) — той же геометрией и в тот же кадр
// (`frame`), поэтому она ложится на цветную пиксель в пиксель. Светотень
// самой цветной текстуры симметрична (фаски темнее со всех сторон): танк
// вращается, и свет, запечённый с одной стороны, поворачивался бы с ним.
// Направленный свет — дело карты нормалей
export default function tankTexture(params, renderer) {
  const { colors } = params;
  const textures = {};

  // фиксированный размер
  const _size = 10;
  const _width = _size * 4;
  const _height = _size * 3;

  const baseColor = 0xeeeeee;

  // корпус: гусеницы по бортам, между ними палуба с фаской (у носа — пологий
  // лобовой лист) и решётка моторного отсека в корме. Габарит — ровно
  // 40 × 30, как у прежнего корпуса: по нему считаются размер меша и тень
  const hullRect = { x: -_width / 2, y: -_height / 2, w: _width, h: _height };
  const deck = { x: -18, y: -9, w: 36, h: 18 };
  const deckBevel = { l: 2, r: 4, t: 2, b: 2 };
  const tracks = [
    { x: -19, y: -14, w: 38, h: 5 },
    { x: -19, y: 9, w: 38, h: 5 },
  ];

  const drawBody = g => {
    g.rect(hullRect.x, hullRect.y, hullRect.w, hullRect.h).fill(0x555555);

    for (const track of tracks) {
      g.rect(track.x, track.y, track.w, track.h).fill(0x3c3c3c);

      // траки поперёк хода
      for (let x = track.x + 1; x < track.x + track.w; x += 3) {
        g.rect(x, track.y, 1, track.h).fill(0x2a2a2a);
      }
    }

    g.rect(deck.x, deck.y, deck.w, deck.h).fill(baseColor);
    bevelFrame(g, deck, deckBevel, {
      l: 0xc4c4c4,
      r: 0xd4d4d4,
      t: 0xc4c4c4,
      b: 0xc4c4c4,
    });

    // решётка моторного отсека
    for (let y = -6; y <= 5; y += 3) {
      g.rect(-15, y, 4, 1).fill(0x8a8a8a);
    }
  };

  const drawBodyNormal = g => {
    g.rect(hullRect.x, hullRect.y, hullRect.w, hullRect.h).fill(FLAT_NORMAL);

    // внешние кромки гусениц и торцы корпуса
    g.rect(hullRect.x, hullRect.y, hullRect.w, 1).fill(normalColor(0, -1, 1));
    g.rect(hullRect.x, hullRect.y + hullRect.h - 1, hullRect.w, 1).fill(
      normalColor(0, 1, 1),
    );
    g.rect(hullRect.x, hullRect.y + 1, 1, hullRect.h - 2).fill(
      normalColor(-1, 0, 1),
    );
    g.rect(hullRect.x + hullRect.w - 1, hullRect.y + 1, 1, hullRect.h - 2).fill(
      normalColor(1, 0, 1),
    );

    bevelFrame(g, deck, deckBevel, {
      l: normalColor(-1, 0, 1),
      // лобовой лист пологий: вдвое шире и наклонён вдвое слабее
      r: normalColor(1, 0, 2),
      t: normalColor(0, -1, 1),
      b: normalColor(0, 1, 1),
    });
  };

  // башня: восьмигранник с фаской, люк, ствол с дульным тормозом
  const turret = [
    1.33, -0.42, 0.42, -1, -0.42, -1, -1.33, -0.42, -1.33, 0.42, -0.42, 1, 0.42,
    1, 1.33, 0.42,
  ].map(value => value * _size);
  const turretInner = 0.6;
  const barrel = { x: 0.25 * _size, y: -0.25 * _size, w: 2.08 * _size };
  const brake = {
    x: 2.1 * _size,
    y: -0.36 * _size,
    w: 0.35 * _size,
    h: 0.72 * _size,
  };
  const hatch = { x: -0.45 * _size, y: 0.35 * _size, r: 0.28 * _size };
  const outline = { width: 0.17 * _size, color: 0xaaaaaa };

  const drawGun = (g, color) => {
    g.poly(turret).fill(color).stroke(outline);
    bevelRing(g, turret, turretInner, () => scaleTint(color, 0.8));
    g.circle(hatch.x, hatch.y, hatch.r)
      .fill(scaleTint(color, 0.65))
      .stroke({ width: 0.08 * _size, color: 0xaaaaaa });
    g.rect(barrel.x, barrel.y, barrel.w, -barrel.y * 2)
      .fill(color)
      .stroke(outline);
    g.rect(brake.x, brake.y, brake.w, brake.h)
      .fill(scaleTint(color, 0.7))
      .stroke({ width: 0.1 * _size, color: 0xaaaaaa });
  };

  const drawGunNormal = g => {
    // подложка — тот же силуэт с той же обводкой: кромка цветной текстуры
    // тоже получает нормаль, а не пустоту
    g.poly(turret)
      .fill(FLAT_NORMAL)
      .stroke({ ...outline, color: FLAT_NORMAL });
    bevelRing(g, turret, turretInner, (nx, ny) => normalColor(nx, ny, 1));

    // ствол и тормоз — цилиндры: верхняя половина смотрит к `−y`, нижняя
    // к `+y`
    const cylinder = ({ x, y, w, h }, stroke) => {
      g.rect(x, y, w, h)
        .fill(FLAT_NORMAL)
        .stroke({ ...stroke, color: FLAT_NORMAL });
      g.rect(x, y, w, h / 2).fill(normalColor(0, -1, 1));
      g.rect(x, y + h / 2, w, h / 2).fill(normalColor(0, 1, 1));
    };

    cylinder({ ...barrel, h: -barrel.y * 2 }, outline);
    cylinder(brake, { width: 0.1 * _size });
  };

  // карта нормалей запекается в КАДР цветной текстуры: так их пиксели
  // совпадают, даже если нормальная геометрия чуть меньше цветной
  const bake = (draw, frame) => {
    const g = new Graphics();

    draw(g);

    const texture = renderer.generateTexture({ target: g, frame });

    g.destroy(true);

    return texture;
  };

  const boundsFrame = draw => {
    const g = new Graphics();

    draw(g);

    const bounds = g.getBounds();

    g.destroy(true);

    return new Rectangle(bounds.x, bounds.y, bounds.width, bounds.height);
  };

  // генерация текстур для живого танка
  const createLiveTankTextures = color => {
    const bodyFrame = boundsFrame(drawBody);
    const gunFrame = boundsFrame(g => drawGun(g, color));

    // якорь пушки: gunFrame.x — смещение левого края текстуры
    // относительно (0,0) Graphics
    const gunAnchor = {
      x: -gunFrame.x / gunFrame.width,
      y: -gunFrame.y / gunFrame.height,
    };

    return {
      body: bake(drawBody, bodyFrame),
      bodyNormal: bake(drawBodyNormal, bodyFrame),
      gun: bake(g => drawGun(g, color), gunFrame),
      gunNormal: bake(drawGunNormal, gunFrame),
      gunAnchor,
    };
  };

  // генерация текстуры для уничтоженного состояния
  const createDestroyedTankTexture = () => {
    const destroyedContainer = new Container();
    const destroyedBody = new Graphics();
    const destroyedGun = new Graphics();

    destroyedContainer.addChild(destroyedBody, destroyedGun);

    const bodyColorDark = 0x3a3a3a;
    const bodyColorDarker = 0x252525;
    const gunColorDark = 0x303030;
    const damageColor = 0x181818;
    const edgeColor = 0x505050;

    const w = _width;
    const h = _height;
    const s = _size;

    // поврежденный корпус
    destroyedBody
      .moveTo(-w / 2 - s * 0.1, -h / 2 + s * 0.2)
      .lineTo(w / 2 + s * 0.2, -h / 2 - s * 0.1)
      .lineTo(w / 2 - s * 0.1, h / 2 + s * 0.3)
      .lineTo(-w / 2 + s * 0.3, h / 2 - s * 0.2)
      .closePath()
      .fill(bodyColorDark)
      .stroke({ width: s * 0.2, color: edgeColor, alignment: 0.5 });

    destroyedBody
      .moveTo(-w / 2 + s * 0.4, -h / 2 + s * 0.5)
      .lineTo(w / 2 - s * 0.3, -h / 2 + s * 0.2)
      .lineTo(w / 2 - s * 0.4, h / 2 - s * 0.1)
      .lineTo(-w / 2 + s * 0.2, h / 2 - s * 0.4)
      .closePath()
      .fill(bodyColorDarker);

    destroyedBody.circle(w * 0.15, h * 0.1, s * 1.2).fill(damageColor);

    destroyedBody.circle(-w * 0.3, -h * 0.25, s * 0.5).fill(damageColor);

    // поврежденная башня
    destroyedGun.position.set(s * 0.3, -s * 0.2);

    const gunBasePoints = [
      s * 1.1,
      -s * 0.7,
      s * 0.2,
      -s * 1.0,
      -s * 0.6,
      -s * 0.9,
      -s * 1.3,
      -s * 0.2,
      -s * 1.1,
      s * 0.6,
      -s * 0.2,
      s * 1.0,
      s * 0.7,
      s * 0.8,
      s * 1.3,
      s * 0.1,
    ];

    destroyedGun
      .poly(gunBasePoints)
      .fill(gunColorDark)
      .stroke({ width: s * 0.15, color: edgeColor, alignment: 0 });

    const barrelPoints = [
      s * 0.8,
      -s * 0.25,
      s * 1.5,
      -s * 0.4,
      s * 1.4,
      s * 0.15,
      s * 0.7,
      s * 0.05,
    ];

    destroyedGun
      .poly(barrelPoints)
      .fill(gunColorDark)
      .stroke({ width: s * 0.1, color: edgeColor, alignment: 0 });

    destroyedGun.circle(s * 0.1, -s * 0.2, s * 0.4).fill(damageColor);

    // генерация единой текстуры для уничтоженного состояния
    const destroyedBounds = destroyedContainer.getBounds();
    const destroyedTexture = renderer.generateTexture({
      target: destroyedContainer,
      frame: new Rectangle(
        destroyedBounds.x,
        destroyedBounds.y,
        destroyedBounds.width,
        destroyedBounds.height,
      ),
    });

    destroyedContainer.destroy({ children: true });

    // рисунок остова ровный: карта нормалей — плоскость на весь кадр,
    // объём ему даёт только наклон
    const normal = new Graphics()
      .rect(
        destroyedBounds.x,
        destroyedBounds.y,
        destroyedBounds.width,
        destroyedBounds.height,
      )
      .fill(FLAT_NORMAL);
    const destroyedNormal = renderer.generateTexture({
      target: normal,
      frame: new Rectangle(
        destroyedBounds.x,
        destroyedBounds.y,
        destroyedBounds.width,
        destroyedBounds.height,
      ),
    });

    normal.destroy(true);

    return { texture: destroyedTexture, normal: destroyedNormal };
  };

  // создание текстур для каждой команды и состояния
  textures.liveTeamId1 = createLiveTankTextures(colors.teamId1);
  textures.liveTeamId2 = createLiveTankTextures(colors.teamId2);
  const destroyed = createDestroyedTankTexture();

  textures.destroyed = destroyed.texture;
  textures.destroyedNormal = destroyed.normal;

  return textures;
}
