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
