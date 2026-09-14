import { describe, it, expect, vi } from 'vitest';
import { Container, Texture } from 'pixi.js';
import Tracks from '../../../src/client/parts/tracks/Tracks.js';
import { createLevelView } from '../../../src/client/levelView.js';
import {
  seeThrough,
  parallax,
  surfaceFx,
} from '../../../src/config/render.js';

// Следы были единственной сущностью 2.5D, не читавшей levelView: на плите
// над игроком они оставались непрозрачными, хотя дым, ящики, танки и бомбы
// уже гасли. И висеть на своём уровне они тоже обязаны — тем же параллаксом,
// что и плита, на которой оставлены.

// строка m1: [x, y, rotation, gunRotation, vX, vY, engineLoad, condition,
// size, teamId, angvel, z, level]
const row = (level = 0, x = 100, y = 100) => [
  x,
  y,
  0,
  0,
  0,
  0,
  0,
  100,
  10,
  1,
  0,
  0,
  level,
];

const renderer = { screen: { width: 800, height: 600 } };

// центр камеры при пустом трансформе сцены — середина полотна
const CAM_X = 400;

const makeTracks = (dependencies, data = row()) => {
  const tracks = new Tracks(data, {}, { renderer, ...dependencies });
  const stage = new Container();

  stage.scale.set(1);
  stage.addChild(tracks);

  return tracks;
};

describe('Tracks: видимость и высота уровня', () => {
  // проверяем ПРОВОДКУ: `onRender` у Container — аксессор, и одноимённый
  // метод на прототипе затенил бы его сеттер, оставив `_onRender` null
  it('регистрирует колбэк onRender в PixiJS', () => {
    const tracks = makeTracks({ levelView: createLevelView(seeThrough) });

    expect(typeof tracks._onRender).toBe('function');

    tracks.destroy();
  });

  it('без сервиса levelView колбэка нет вовсе', () => {
    const tracks = makeTracks({});

    expect(tracks._onRender).toBe(null);

    tracks.destroy();
  });

  it('следы на плите над игроком гаснут, под игроком — темнеют', () => {
    const view = createLevelView(seeThrough);
    const tracks = makeTracks({ levelView: view }, row(1));
    const layer = tracks._markLayer(1);

    // игрок на земле рядом со следами: они над ним — гаснут
    view.set(0, 100, 100, 0);
    tracks.onRender();

    expect(layer.alpha).toBeCloseTo(seeThrough.minAlpha, 5);
    expect(layer.tint).toBe(0xffffff);

    // игрок сам поднялся на плиту: следы видны целиком
    view.set(1, 100, 100, 0);
    tracks.onRender();

    expect(layer.alpha).toBe(1);

    // следы уровня 0 под поднявшимся игроком — затемняются
    const ground = tracks._markLayer(0);

    tracks.onRender();

    expect(ground.tint).toBe(seeThrough.lowerTint);

    tracks.destroy();
  });

  it('контейнер отметок уровня 1 смещён параллаксом, земля — нет', () => {
    const view = createLevelView(seeThrough);
    const tracks = makeTracks({ levelView: view }, row(1));
    const layer = tracks._markLayer(1);
    const ground = tracks._markLayer(0);

    tracks.onRender();

    const k = parallax.shear;

    expect(layer.scale.x).toBeCloseTo(1 + k, 6);
    expect(layer.position.x).toBeCloseTo(-CAM_X * k, 6);
    expect(ground.scale.x).toBe(1);
    expect(ground.position.x).toBe(0);

    tracks.destroy();
  });

  it('с сервисом surfaces колбэк onRender по-прежнему регистрируется', () => {
    const tracks = makeTracks({
      levelView: createLevelView(seeThrough),
      surfaces: { kindAt: () => 'oil', dirAt: () => null },
    });

    expect(typeof tracks._onRender).toBe('function');

    tracks.destroy();
  });

  it('без единой отметки колбэк не считает ничего', () => {
    const view = createLevelView(seeThrough);
    const alphaFor = vi.spyOn(view, 'alphaFor');
    const tracks = makeTracks({ levelView: view });

    tracks.onRender();

    expect(alphaFor).not.toHaveBeenCalled();

    tracks.destroy();
  });
});

describe('Tracks: поверхности', () => {
  const assets = { trackMarkTexture: Texture.WHITE };

  const makeOn = kind => {
    const surfaces = { kindAt: vi.fn(() => kind), dirAt: () => null };
    const tracks = new Tracks(row(), assets, { renderer, surfaces });

    new Container().addChild(tracks);

    return { tracks, surfaces };
  };

  const marks = tracks => tracks._markLayer(0).children;

  it('без сервиса surfaces следы прежние', () => {
    const tracks = new Tracks(row(), assets, { renderer });

    tracks.createTrackMarksAtPreviousPosition();

    expect(marks(tracks).length).toBe(2);
    expect(marks(tracks)[0].alpha).toBeCloseTo(0.4, 5);
    expect(marks(tracks)[0].tint).toBe(0xffffff);

    tracks.destroy();
  });

  it('на нейтральной клетке следы прежние', () => {
    const { tracks, surfaces } = makeOn(null);

    tracks.createTrackMarksAtPreviousPosition();

    expect(surfaces.kindAt).toHaveBeenCalledWith(100, 100, 0);
    expect(marks(tracks)[0].alpha).toBeCloseTo(0.4, 5);

    tracks.destroy();
  });

  it('вода следов не оставляет', () => {
    const { tracks } = makeOn('water');

    tracks.createTrackMarksAtPreviousPosition();

    expect(marks(tracks).length).toBe(0);

    tracks.destroy();
  });

  it('масло: тёмный след плотнее и живёт дольше', () => {
    const { tracks } = makeOn('oil');
    const plain = new Tracks(row(), assets, { renderer });

    tracks.createTrackMarksAtPreviousPosition();
    plain.createTrackMarksAtPreviousPosition();

    const oil = marks(tracks)[0];

    expect(oil.tint).toBe(surfaceFx.tracks.oil.tint);
    expect(oil.alpha).toBeGreaterThan(marks(plain)[0].alpha);
    // минимальная жизнь масляного следа длиннее максимальной обычного
    expect(oil._fadeDuration).toBeGreaterThanOrEqual(
      1800 * surfaceFx.tracks.oil.lifetime,
    );

    tracks.destroy();
    plain.destroy();
  });

  it('грязь темнит след', () => {
    const { tracks } = makeOn('mud');

    tracks.createTrackMarksAtPreviousPosition();

    expect(marks(tracks)[0].tint).toBe(surfaceFx.tracks.mud.tint);

    tracks.destroy();
  });
});
