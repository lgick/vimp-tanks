import { describe, it, expect } from 'vitest';
import {
  collectRequiredImages,
  collectMissingImages,
} from '../../scripts/lib/collectMissingImages.js';

// Гейт сборки (build-game-manifest.js): карта, назвавшая несуществующую
// картинку, должна валить npm run build. В рантайме такой промах молчалив —
// карта просто отрисуется пустым полотном.

const staticMap = {
  spriteSheet: { img: 'tiles.png' },
  physicsDynamic: [{ img: 'b1.png' }, { img: 'bob.jpg' }],
};

describe('collectRequiredImages', () => {
  it('карта без картинок ничего не требует', () => {
    expect(collectRequiredImages([{ map: [[0]] }])).toEqual([]);
  });

  it('берёт spriteSheet.img и img каждого динамического тела', () => {
    expect(collectRequiredImages([staticMap])).toEqual([
      'b1.png',
      'bob.jpg',
      'tiles.png',
    ]);
  });

  it('динамическое тело без картинки пропускается', () => {
    const map = { spriteSheet: { img: 'tiles.png' }, physicsDynamic: [{}] };

    expect(collectRequiredImages([map])).toEqual(['tiles.png']);
  });

  it('берёт картинки состояний пропа из game', () => {
    const map = {
      physicsDynamic: [
        {
          img: 'crate.png',
          game: {
            prop: 'crate',
            imgDamaged: 'crate-damaged.png',
            imgDestroyed: 'crate-debris.png',
          },
        },
        // бочка без imgDestroyed: копоть процедурная, файла не требует
        { img: 'barrel.png', game: { prop: 'barrel' } },
      ],
    };

    expect(collectRequiredImages([map])).toEqual([
      'barrel.png',
      'crate-damaged.png',
      'crate-debris.png',
      'crate.png',
    ]);
  });

  it('одно и то же имя из разных карт не дублируется', () => {
    const other = { spriteSheet: { img: 'tiles.png' } };

    expect(collectRequiredImages([staticMap, other])).toEqual([
      'b1.png',
      'bob.jpg',
      'tiles.png',
    ]);
  });
});

describe('collectMissingImages', () => {
  const required = collectRequiredImages([staticMap]);

  it('все файлы на месте — пусто', () => {
    expect(collectMissingImages(required, () => true)).toEqual([]);
  });

  it('отсутствующий файл попадает в результат', () => {
    const missing = collectMissingImages(required, file => file !== 'b1.png');

    expect(missing).toEqual(['b1.png']);
  });

  it('порядок сохраняется (сортировка из collectRequiredImages)', () => {
    expect(collectMissingImages(required, () => false)).toEqual([
      'b1.png',
      'bob.jpg',
      'tiles.png',
    ]);
  });
});
