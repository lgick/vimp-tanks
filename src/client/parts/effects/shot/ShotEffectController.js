import { Container } from 'pixi.js';
import TracerEffect from './TracerEffect.js';
import { tracerPieces } from './tracerPieces.js';
import ImpactEffect from './ImpactEffect.js';
import MuzzleFlashEffect from './MuzzleFlashEffect.js';
import { OCCLUDER_BASE_Z, levelZ } from '../../../levelZ.js';
import { cameraCenter } from '../../../camera.js';
import { applyParallax, reproject } from '../../../parallax.js';
import { EMISSIVE_BASE_Z } from '../../../lighting/lightMath.js';
import { crossingDistance, edgeFace, faceIsFront } from '../../../wallFace.js';
import {
  parallax as parallaxConfig,
  lighting as lightingConfig,
  tracer as tracerConfig,
} from '../../../../config/render.js';
import {
  W1_START_X,
  W1_START_Y,
  W1_START_LEVEL,
  W1_END_X,
  W1_END_Y,
  W1_BODY_X,
  W1_BODY_Y,
  W1_WAS_HIT,
  W1_SHOOTER_ID,
  W1_END_LEVEL,
  W1_ANCHOR,
  W1_HIT_SLOPE,
  W1_HIT_EMBANKMENT_FACE,
} from '../../../snapshotFields.js';

// базовый zIndex трассера и осколков внутри своего уровня
const SHOT_BASE_Z = 2;

// попадание в видимую грань — над перекрывателем (иначе грань закрывает
// конец трассера и падающие осколки), под картой освещённости
const WALL_HIT_BASE_Z = OCCLUDER_BASE_Z + 0.5;

// допуск «конец луча на кромке клетки», мировые единицы: хост округляет
// точку удара до 0.1
const WALL_EDGE_TOLERANCE = 0.15;

export default class ShotEffectController extends Container {
  constructor(data, assets, dependencies) {
    super();

    this.startPositionX = data[W1_START_X];
    this.startPositionY = data[W1_START_Y];
    this.endPositionX = data[W1_END_X];
    this.endPositionY = data[W1_END_Y];
    this.soundPositionX = data[W1_BODY_X];
    this.soundPositionY = data[W1_BODY_Y];
    this.hitCode = data[W1_WAS_HIT] || 0;
    this.hit = this.hitCode !== 0;

    // 2.5D: осколки и вспышка — на уровне КОНЦА луча, иначе осколки
    // провалятся под мост. Трассер режется по сегментам уровней ядра и
    // рисуется кусками на своих уровнях (`_layerFor`): луч с моста идёт над
    // плитой и дальше на её высоте (воздушный сегмент ядра). Уровень начала (`W1_START_LEVEL`) нужен
    // сегментам и вспышке выстрела на стволе
    this.endLevel = data[W1_END_LEVEL] || 0;
    this.startLevel = data[W1_START_LEVEL] || 0;
    this.zIndex = levelZ(SHOT_BASE_Z, this.endLevel);

    // якорь попадания в динамику карты — одиннадцатый элемент строки, только
    // у своего локально предсказанного трассера (см. build_tracer в
    // core/src/client/shot.rs); авторитетные трассеры (длина 10) его не
    // несут — data[W1_ANCHOR] === undefined
    this.anchorKey = null;
    this.anchorLocalX = 0;
    this.anchorLocalY = 0;

    if (Array.isArray(data[W1_ANCHOR])) {
      [this.anchorKey, this.anchorLocalX, this.anchorLocalY] = data[W1_ANCHOR];
    }

    this._assets = assets;
    this._soundManager = dependencies.soundManager;

    // свой ли это выстрел: звук своего выстрела берёт позицию корпуса
    // стрелка на момент выстрела, а слушатель — центр камеры, то есть
    // предсказанный свой танк. Предсказанный локальный выстрел и его
    // авторитетное эхо не совпадают по позиции — один и тот же выстрел
    // звучал то по центру, то целиком в одно ухо. Свой выстрел принадлежит
    // игроку, а не миру, поэтому не панорамируется
    this._isLocalShot =
      dependencies.localPlayer?.is(data[W1_SHOOTER_ID]) === true;

    // отдача: танк стрелка откатывается (src/client/recoil.js). Эффект
    // создаётся раз на выстрел — свой предсказанный, а авторитетный дубль
    // ядро отфильтровывает
    dependencies.shots?.fired(data[W1_SHOOTER_ID]);
    this._mapDynamics = dependencies.mapDynamics || null;
    // дуло стрелка: пока идут трассер и вспышка, они держатся у ствола
    // едущего танка (сервис `shots`, src/client/shotEvents.js)
    this._shots = dependencies.shots || null;
    this._shooterId = data[W1_SHOOTER_ID];
    this._levelView = dependencies.levelView || null;
    // ночь: вспышка выстрела на стволе (no-op днём)
    this._lighting = dependencies.lighting || null;
    // высоты объёмов карты (src/client/volumes.js): попадание в стену
    // рисуется на её видимой грани, а не на подножии
    this._volumes = dependencies.volumes || null;
    // прогоны рамп (сервис `rampRuns`): осколки на склоне лежат на склоне,
    // а не на полу уровня конца луча (`_debrisSurface`, `_placeDebris`)
    this._rampRuns = dependencies.rampRuns || null;
    // задетая стена `{ face, volume, base }` (`_wallEnd`); null — не стена
    this._wall = null;

    // трассер и осколки уступают видимость игроку под плитой ровно так же,
    // как всё остальное на верхнем уровне (единая формула — в levelView).
    // `onRender` — аксессор Container, назначается свойством
    this._renderer = dependencies.renderer || null;

    if (this._levelView || this._renderer) {
      this.onRender = () => {
        if (this._levelView) {
          this.alpha = this._levelView.alphaFor(
            this.endLevel,
            this.endPositionX,
            this.endPositionY,
          );
          this.tint = this._levelView.tintFor(this.endLevel);
        }

        // проекция высоты: трассер и осколки на мосту стоят на мосту, а
        // осколки на склоне рампы — на склоне (`_placeDebris`).
        // Дети контроллера авторятся в мировых координатах, сам он
        // единичный — трансформ контейнера даёт им ровно offsetPoint
        const camera = cameraCenter(this.parent, this._renderer);

        applyParallax(this, camera, this.endLevel * parallaxConfig.shear, 1);

        for (const [level, layer] of this.layers) {
          if (this._levelView) {
            layer.alpha = this._levelView.alphaFor(
              level,
              layer.refX,
              layer.refY,
            );
            layer.tint = this._levelView.tintFor(level);
          }

          applyParallax(layer, camera, level * parallaxConfig.shear, 1);
        }

        this._followMuzzle();
        this._placeFlash(camera);
        this._placeDebris(camera);
        this._placeImpactZ(camera);
      };
    }

    this.tracer = null;
    // контейнеры кусков трассера по уровням (см. _layerFor): level -> Container
    this.layers = new Map();
    this.impact = null;
    // вспышка у дула; пока её нет, ждать нечего
    this.flash = null;
    this._flashComplete = true;
    this._isDestroyed = false;

    // флаги для управления жизненным циклом
    this._visualsComplete = false;
    this._soundComplete = false;

    // звук выстрела в момент старта эффекта
    this._soundId = this._soundManager.registerSound(
      'shot',
      {
        position: { x: this.soundPositionX, y: this.soundPositionY },
        spatial: !this._isLocalShot,
      },
      () => {
        this._soundComplete = true;
        this._soundId = null;
        this._tryDestroy();
      },
    );

    // если по какой-то причине звук не запустился,
    // сразу считаем его "завершенным"
    if (!this._soundId) {
      this._soundComplete = true;
    }
  }

  run() {
    if (this._isDestroyed) {
      return;
    }

    this._lighting?.flash({
      ...lightingConfig.flash.shot,
      level: this.startLevel,
      x: this.startPositionX,
      y: this.startPositionY,
      z: this.startLevel,
    });

    // вспышка у дула — по направлению луча: оно и есть направление ствола
    const dx = this.endPositionX - this.startPositionX;
    const dy = this.endPositionY - this.startPositionY;
    const dist = Math.hypot(dx, dy);

    if (dist > 0.001) {
      this._flashComplete = false;
      this.flash = new MuzzleFlashEffect(
        this.startPositionX,
        this.startPositionY,
        dx / dist,
        dy / dist,
        () => {
          this._flashComplete = true;
          this._tryDestroy();
        },
      );
      this.addChild(this.flash);
      this.flash.run();
    }

    // видимый конец луча: у выстрела в склон рампы — на склоне на высоте
    // пули, у попадания в стену или грань насыпи — на грани. Точка удара
    // (`endPositionX/Y`) остаётся исходной
    const end = this._slopeEnd(dist) ?? this._wallEnd(dx, dy, dist);
    const pieces = tracerPieces(
      this._shots?.path?.(
        this.startPositionX,
        this.startPositionY,
        end.x,
        end.y,
        this.startLevel,
      ),
      end.dist,
      this.endLevel,
    );

    this.tracer = new TracerEffect(
      this.startPositionX,
      this.startPositionY,
      end.x,
      end.y,
      this._onTracerComplete.bind(this),
      tracerConfig,
      {
        pieces,
        layerFor: level => this._layerFor(level, pieces),
        stopLine: end.stopLine,
      },
    );

    this.addChild(this.tracer);
    this.tracer.run();
  }

  // Задетая стена: конец луча на кромке клетки, а клетка за кромкой по
  // ходу луча — объём уровня конца, или грань насыпи рампы
  // (`W1_HIT_EMBANKMENT_FACE`). `{ face, volume }` или null. Грань стоит на
  // полу под пулей (`_floorAt`): у пули с моста — на земле. `base` — уровень
  // этого пола
  _wallAt(nx, ny) {
    if (!this.hit) {
      return null;
    }

    // грань насыпи рампы (борт или торец): ядро остановило пулю на ней
    // ниже её верха — рисуется тем же путём, что стена
    if (this.hitCode === W1_HIT_EMBANKMENT_FACE) {
      const ahead = 2 * WALL_EDGE_TOLERANCE;
      const base = this._floorAt(
        this.endPositionX + nx * ahead,
        this.endPositionY + ny * ahead,
      );
      const found = this._rampRuns?.faceAt?.(
        base,
        this.endPositionX,
        this.endPositionY,
        nx,
        ny,
        WALL_EDGE_TOLERANCE,
      );

      return found ? { ...found, base } : null;
    }

    if (!this._volumes) {
      return null;
    }

    const { cellW, cellH } = this._volumes.cellSize();

    if (!(cellW > 0 && cellH > 0)) {
      return null;
    }

    const face = edgeFace(
      this.endPositionX,
      this.endPositionY,
      nx,
      ny,
      cellW,
      cellH,
      WALL_EDGE_TOLERANCE,
    );

    if (!face) {
      return null;
    }

    const probe = 0.01 * Math.min(cellW, cellH);
    const px = this.endPositionX + nx * probe;
    const py = this.endPositionY + ny * probe;
    const base = this._floorAt(px, py);
    const volume = this._volumes.heightAt(base, px, py);

    return volume > 0 ? { face, volume, base } : null;
  }

  // Уровень пола под мировой точкой для конца луча. `endLevel` — уровень
  // полёта пули: у пули с моста над землёй пол ниже (`rampRuns.floorAt`,
  // core.floor_level). Без сервиса — уровень конца, как раньше
  _floorAt(x, y) {
    const floor = this._rampRuns?.floorAt?.(this.endLevel, x, y);

    return Number.isInteger(floor) ? floor : this.endLevel;
  }

  // Видимый конец трассера `{ x, y, dist, stopLine }` у попадания в стену
  // или грань насыпи рампы (`W1_HIT_EMBANKMENT_FACE`). Стрельба идёт по
  // полу, и луч хоста кончается на ПОДНОЖИИ стены, а видна её грань:
  //   - грань смотрит на центр проекции — конец ложится на неё на высоте
  //     ствола (`tracer.height`), контроллер — над перекрывателем;
  //   - грань отвёрнута (камера за стеной) — трассер обрывается на силуэте
  //     крыши (верхняя кромка грани), иначе он рисуется поверх крыши до
  //     спрятанного под ней подножия.
  // Сторона грани считается раз при выстреле: за 45–80 мс пролёта камера
  // сдвигается мало. `stopLine` — линия грани для `TracerEffect.shiftTo`
  _wallEnd(dx, dy, dist) {
    const plain = {
      x: this.endPositionX,
      y: this.endPositionY,
      dist,
      stopLine: null,
    };

    if (!(dist > 0.001)) {
      return plain;
    }

    const nx = dx / dist;
    const ny = dy / dist;

    this._wall = this._wallAt(nx, ny);

    if (!this._wall) {
      return plain;
    }

    const camera =
      this._levelView?.camera() ?? cameraCenter(this.parent, this._renderer);

    if (!camera) {
      return plain;
    }

    const { face, volume, base } = this._wall;
    const { shear } = parallaxConfig;
    const kBase = this.endLevel * shear;
    let x;
    let y;

    if (faceIsFront(face, this.endPositionX, this.endPositionY, camera)) {
      ({ x, y } = reproject(
        this.endPositionX,
        this.endPositionY,
        camera,
        kBase,
        (this.endLevel + tracerConfig.height) * shear,
      ));
      this.zIndex = levelZ(WALL_HIT_BASE_Z, this.endLevel);
    } else {
      const t = crossingDistance({
        x0: this.startPositionX,
        y0: this.startPositionY,
        dx: nx,
        dy: ny,
        face,
        camera,
        kBase,
        kLine: (base + volume) * shear,
      });
      const along = t === null ? dist : Math.min(dist, Math.max(0, t));

      x = this.startPositionX + nx * along;
      y = this.startPositionY + ny * along;
    }

    return {
      x,
      y,
      dist: Math.hypot(x - this.startPositionX, y - this.startPositionY),
      stopLine: { axis: face.axis, coord: face.axis === 'x' ? x : y },
    };
  }

  // Видимый конец выстрела в склон рампы (`W1_HIT_SLOPE`) `{ x, y, dist,
  // stopLine }` или null. Ядро уже остановило луч там, где насыпь
  // поднялась выше пули (core/src/shot_height.rs), — в этой точке высота
  // склона и есть высота пули. Кусок трассера стоит в проекции пола уровня
  // конца, поэтому конец переносится на склон (`reproject`); линия равной
  // высоты склона перпендикулярна оси прогона — она и есть `stopLine`.
  // Осколки лягут на склон сами (`_debrisSurface`)
  _slopeEnd(dist) {
    const slope =
      this.hitCode === W1_HIT_SLOPE && dist > 0.001
        ? this._rampRuns?.slopeAt?.(
            this.endLevel,
            this.endPositionX,
            this.endPositionY,
          )
        : null;

    if (!slope) {
      return null;
    }

    const camera =
      this._levelView?.camera() ?? cameraCenter(this.parent, this._renderer);
    const { shear } = parallaxConfig;
    const { x, y } = reproject(
      this.endPositionX,
      this.endPositionY,
      camera,
      this.endLevel * shear,
      slope.height * shear,
    );

    return {
      x,
      y,
      dist: Math.hypot(x - this.startPositionX, y - this.startPositionY),
      stopLine: {
        axis: slope.axis === 0 ? 'x' : 'y',
        coord: slope.axis === 0 ? x : y,
      },
    };
  }

  // Коэффициент проекции поверхности под мировой точкой для осколков: на
  // склоне рампы — высота склона (`rampRuns.heightAt`, та же, что у вершин
  // клина), иначе null — пол уровня конца. Нужен выстрелу в склон
  // (`W1_HIT_SLOPE`) и попаданию в танк на рампе: танк виден лучам обоих
  // уровней, а нарисован на своём `z`. У стены и грани насыпи осколки
  // падают на эту поверхность с высоты ствола (`_debrisStartK`). Пол под
  // осколком — `_floorAt`: осколки попадания пули с моста падают на землю,
  // а не висят на высоте моста
  _debrisSurface() {
    const ramps = this._rampRuns;

    if (typeof ramps?.heightAt !== 'function') {
      return null;
    }

    const level = this.endLevel;
    const { shear } = parallaxConfig;

    return (x, y) => {
      const floor = this._floorAt(x, y);
      const height = ramps.heightAt(floor, x, y);

      if (height !== null) {
        return height * shear;
      }

      // пол ниже уровня конца (пуля с моста над землёй): осколки на нём
      return floor < level ? floor * shear : null;
    };
  }

  // Коэффициент высоты рождения осколков: у стены и грани насыпи — высота
  // ствола, там же конец трассера на грани (`_wallEnd`); у воздушного
  // попадания — уровень полёта; иначе null — сразу на поверхности
  _debrisStartK() {
    const { shear } = parallaxConfig;

    if (this._wall) {
      return (this.endLevel + tracerConfig.height) * shear;
    }

    // склон: конец нарисован на склоне — осколки сразу на нём
    if (this.hitCode === W1_HIT_SLOPE) {
      return null;
    }

    // воздушное попадание (танк у верха рампы с моста): конец нарисован
    // на уровне полёта, пол под ним ниже — осколки падают на него
    return this._floorAt(this.endPositionX, this.endPositionY) < this.endLevel
      ? this.endLevel * shear
      : null;
  }

  // Осколки попадания лежат на поверхности под собой: на склоне рампы —
  // в его проекции, а не пола уровня конца (`ImpactEffect.project`)
  _placeDebris(camera) {
    const impact = this.impact;

    if (!impact || impact.destroyed || impact.parent !== this) {
      return;
    }

    impact.project(camera, this.endLevel * parallaxConfig.shear);
  }

  // Осколки попадания в стену: пока они падают перед видимой гранью,
  // контроллер над перекрывателем (иначе грань закрыла бы их). Лежащие
  // на полу и за отвёрнутой гранью — под ним, под крышей, как всё на
  // полу. Сторона — каждый кадр: осколки лежат 6–15 с, камера за это
  // время уходит далеко
  _placeImpactZ(camera) {
    const impact = this.impact;

    if (!this._wall || !impact || impact.destroyed) {
      return;
    }

    const front = Boolean(
      camera &&
      faceIsFront(
        this._wall.face,
        this.endPositionX,
        this.endPositionY,
        camera,
      ),
    );

    this.zIndex = levelZ(
      front && impact.isFalling() ? WALL_HIT_BASE_Z : SHOT_BASE_Z,
      this.endLevel,
    );
  }

  // Контейнер куска трассера уровня `level`. Днём кусок уровня конца
  // рисуется в самом контроллере, как раньше. Остальные уровни — соседние
  // контейнеры на сцене со своими zIndex и проекцией. Ночью трассер — свет:
  // под картой освещённости (multiply) вдали от фар он гас до `ambient`, и
  // дальний выстрел «не появлялся», поэтому все его куски — над картой
  // своего уровня (эмиссив). Осколки и вспышка остаются под ней
  _layerFor(level, pieces) {
    const night = Boolean(this._lighting?.isNight?.());

    if ((!night && level === this.endLevel) || !this.parent) {
      return this;
    }

    let layer = this.layers.get(level);

    if (!layer) {
      const piece = pieces.find(entry => entry.level === level);
      const mid = piece ? (piece.from + piece.to) / 2 : 0;
      const dx = this.endPositionX - this.startPositionX;
      const dy = this.endPositionY - this.startPositionY;
      const total = Math.hypot(dx, dy) || 1;

      layer = new Container();
      layer.label = `shot-tracer-${level}`;
      layer.eventMode = 'none';
      layer.zIndex = levelZ(night ? EMISSIVE_BASE_Z : SHOT_BASE_Z, level);
      // точка, по которой слой уступает видимость игроку под плитой
      layer.refX = this.startPositionX + (dx / total) * mid;
      layer.refY = this.startPositionY + (dy / total) * mid;
      this.parent.addChild(layer);
      this.layers.set(level, layer);
    }

    return layer;
  }

  // Танк едет, эффект живёт в мире: за время пролёта трассера корпус
  // проезжает свою длину, и при стрельбе вбок хвост отрывался от ствола. А
  // чужой танк ещё и нарисован с задержкой интерполяции. Поэтому трассер и
  // вспышка идут за ТЕКУЩИМ дулом стрелка: луч переносится целиком
  // (`TracerEffect.shiftTo`), без поворота. Осколки попадания появляются в
  // исходной точке удара — стена на месте
  _followMuzzle() {
    if (!this._shots || this.impact) {
      return;
    }

    const tracerRunning = this.tracer && !this.tracer.isComplete;
    const flashRunning = this.flash && !this.flash.isComplete;

    if (!tracerRunning && !flashRunning) {
      return;
    }

    const muzzle = this._shots.muzzle(this._shooterId);

    if (!muzzle) {
      return;
    }

    this.startPositionX = muzzle.x;
    this.startPositionY = muzzle.y;

    if (tracerRunning) {
      this.tracer.shiftTo(muzzle.x, muzzle.y);
    }
  }

  // Контроллер рисуется в проекции уровня КОНЦА луча, а дуло — на уровне
  // начала. Если они разные (выстрел с моста вниз), вспышку переносим в
  // проекцию дула внутри проекции контроллера (`reproject`, parallax.js)
  _placeFlash(camera) {
    if (!this.flash || this.flash.destroyed) {
      return;
    }

    // кадр без центра камеры: вспышка ровно в точке вылета, а не в
    // проекции прошлого кадра (это делает `reproject`)
    const { shear } = parallaxConfig;
    const point = reproject(
      this.startPositionX,
      this.startPositionY,
      camera,
      this.endLevel * shear,
      this.startLevel * shear,
    );

    this.flash.position.set(point.x, point.y);
    this.flash.scale.set(point.scale);
  }

  // трассер завершил анимацию.
  // Его графика уже должна быть очищена TracerEffect'ом.
  // сам объект TracerEffect будет уничтожен в destroy
  _onTracerComplete() {
    if (this._isDestroyed) {
      return;
    }

    if (this.hit) {
      let impactX = this.endPositionX;
      let impactY = this.endPositionY;

      // ящик мог уехать за 45-80 мс анимации трассера (TracerEffect): точка
      // удара пересчитывается из ТЕКУЩЕГО трансформа ящика, а не из того,
      // что был в момент выстрела, — иначе облако осколков окажется позади
      // уехавшего ящика. Дальше осколки остаются лежать на месте: за ящиком
      // они не следуют (ImpactEffect работает в мире)
      if (this.anchorKey !== null && this._mapDynamics) {
        const point = this._mapDynamics.toWorld(
          this.anchorKey,
          this.anchorLocalX,
          this.anchorLocalY,
        );

        if (point) {
          impactX = point.x;
          impactY = point.y;
        }
      }

      const dx = impactX - this.startPositionX;
      const dy = impactY - this.startPositionY;
      const dist = Math.hypot(dx, dy);
      let impactDirectionX = 0,
        impactDirectionY = 0;

      if (dist > 0.001) {
        impactDirectionX = -(dx / dist);
        impactDirectionY = -(dy / dist);
      }

      this.impact = new ImpactEffect(
        impactX,
        impactY,
        impactDirectionX,
        impactDirectionY,
        this._onImpactComplete.bind(this), // callback
        this._assets,
        {
          surfaceK: this._debrisSurface(),
          startK: this._debrisStartK(),
        },
      );

      this.addChild(this.impact);
      this.impact.run();

      // иначе, если попадания не было,
      // то после завершения трассера эффект считается завершенным
    } else {
      // визуальная часть завершена, попытка уничтожить объект
      this._visualsComplete = true;
      this._tryDestroy();
    }
  }

  _onImpactComplete() {
    if (this._isDestroyed) {
      return;
    }

    // визуальная часть завершена, попытка уничтожить объект
    this._visualsComplete = true;
    this._tryDestroy();
  }

  // проверяет, завершены ли звук и визуал, и если да, уничтожает объект
  _tryDestroy() {
    if (this._visualsComplete && this._soundComplete && this._flashComplete) {
      this.destroy();
    }
  }

  destroy() {
    if (this._isDestroyed) {
      return;
    }

    this._isDestroyed = true;

    // этот вызов остается на случай, если эффект уничтожат принудительно,
    // до того как звук закончится сам
    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }

    if (this.tracer) {
      this.tracer.destroy();
      this.tracer = null;
    }

    for (const layer of this.layers.values()) {
      layer.destroy({ children: true });
    }

    this.layers.clear();

    if (this.impact) {
      this.impact.destroy();
      this.impact = null;
    }

    if (this.flash) {
      this.flash.destroy();
      this.flash = null;
    }

    if (this.parent) {
      this.parent.removeChild(this);
    }

    // children:true уничтожит все, что еще осталось
    super.destroy({ children: true });
  }
}
