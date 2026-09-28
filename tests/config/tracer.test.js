import { describe, it, expect } from 'vitest';
import models from '../../src/data/models.js';
import { tracer, tankModel } from '../../src/config/render.js';

// Высота полёта пули (`tracer.height`, уровни) — высота ствола модели танка.
// Общего источника у них нет: ствол задан в пикселях рисунка корпуса
// (`tankModel.barrelHeight` при базовом size 10), а трассер — в уровнях.
// Разойдутся — выстрел в стену упрётся в грань выше или ниже ствола.
describe('tracer.height ↔ высота ствола модели', () => {
  it('совпадает с barrelHeight · size / 10 / levelHeight', () => {
    const barrel =
      (tankModel.barrelHeight * models.m1.size) / 10 / tankModel.levelHeight;

    expect(Math.abs(tracer.height - barrel)).toBeLessThanOrEqual(0.01);
  });
});

// Ядро держит высоту ствола в данных модели (`models.m1.barrelHeight`,
// мировые единицы — на ней летит пуля hitscan, core/src/shot_height.rs),
// рендер — в пикселях рисунка и в уровнях трассера. Общего источника нет:
// разойдутся — конец выстрела в насыпь нарисуется не там, где его
// остановило ядро.
describe('models.m1.barrelHeight ↔ рендер', () => {
  it('совпадает с tankModel.barrelHeight · size / 10', () => {
    expect(models.m1.barrelHeight).toBe(
      (tankModel.barrelHeight * models.m1.size) / 10,
    );
  });

  it('tracer.height ≈ barrelHeight / levelHeight', () => {
    expect(
      Math.abs(tracer.height - models.m1.barrelHeight / tankModel.levelHeight),
    ).toBeLessThanOrEqual(0.01);
  });
});
