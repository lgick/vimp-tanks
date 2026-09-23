import { Geometry, Mesh } from 'pixi.js';
import { faceUVs } from './uv.js';
import { createTankModelShader, setTankModelTexture } from './shader.js';

// Меш модели танка: у каждой грани свои вершины (у соседних граней разные
// UV и яркость), треугольники — веером. Позиции и яркость пишутся раз в
// кадр для всех граней, а индексы — только видимых и в порядке отрисовки;
// хвост индексного буфера заполняется нулями (вырожденные треугольники),
// поэтому размер буферов постоянный.

/**
 * @param {{ vertices: number[][], faces: object[] }} model
 * @param {{ texture: object, width: number, height: number,
 *   regions: object }} atlas
 */
export function createTankModelMesh(model, atlas) {
  // раскладка: начало вершин каждой грани в общем буфере
  const offsets = [];
  let vertexCount = 0;
  let triangleCount = 0;

  for (const face of model.faces) {
    offsets.push(vertexCount);
    vertexCount += face.indices.length;
    triangleCount += face.indices.length - 2;
  }

  const positions = new Float32Array(vertexCount * 2);
  const uvs = new Float32Array(vertexCount * 2);
  const shades = new Float32Array(vertexCount).fill(1);
  const indices = new Uint32Array(triangleCount * 3);

  const writeUVs = target => {
    faceUVs(model, target).forEach((corners, face) => {
      corners.forEach(([x, y], k) => {
        uvs[(offsets[face] + k) * 2] = x;
        uvs[(offsets[face] + k) * 2 + 1] = y;
      });
    });
  };

  writeUVs(atlas);

  const geometry = new Geometry({
    attributes: {
      aPosition: { buffer: positions, format: 'float32x2' },
      aUv: { buffer: uvs, format: 'float32x2' },
      aShade: { buffer: shades, format: 'float32' },
    },
    indexBuffer: indices,
  });

  const shader = createTankModelShader(atlas.texture);
  const mesh = new Mesh({ geometry, shader, texture: atlas.texture });

  return {
    mesh,

    // смена атласа (команда): UV те же по раскладке, но атлас другой
    setAtlas(next) {
      writeUVs(next);
      geometry.getBuffer('aUv').update();
      setTankModelTexture(shader, next.texture);
      mesh.texture = next.texture;
    },

    /**
     * @param {number[][]} projected  2D-точки вершин модели
     * @param {number[]} faceShades   яркость каждой грани
     * @param {number[]} order        видимые грани в порядке отрисовки
     */
    update(projected, faceShades, order) {
      model.faces.forEach((face, f) => {
        const base = offsets[f];

        face.indices.forEach((vertex, k) => {
          positions[(base + k) * 2] = projected[vertex][0];
          positions[(base + k) * 2 + 1] = projected[vertex][1];
          shades[base + k] = faceShades[f];
        });
      });

      let cursor = 0;

      for (const f of order) {
        const base = offsets[f];
        const count = model.faces[f].indices.length;

        for (let k = 1; k < count - 1; k += 1) {
          indices[cursor] = base;
          indices[cursor + 1] = base + k;
          indices[cursor + 2] = base + k + 1;
          cursor += 3;
        }
      }

      indices.fill(0, cursor);

      geometry.getBuffer('aPosition').update();
      geometry.getBuffer('aShade').update();
      geometry.indexBuffer.update();
    },

    destroy() {
      mesh.destroy();
      shader.destroy();
      geometry.destroy();
    },
  };
}
