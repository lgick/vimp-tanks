import { describe, it, expect } from 'vitest';
import clientConfig from '../../src/config/client.js';

// componentDependencies: движок раздаёт сервис только тем партам, которые
// названы здесь. Пропуск имени не ломает сборку — парт молча получает
// undefined, поэтому связка «сервис → парт» закреплена тестом.
describe('clientConfig.componentDependencies (src/config/client.js)', () => {
  const deps = clientConfig.parts.componentDependencies;

  it('levelView объявлен для Tank (пишет) и Map (читает)', () => {
    expect(deps.levelView).toEqual(['Tank', 'Map']);
  });

  it('localPlayer объявлен для Tank: только свой танк пишет в levelView', () => {
    expect(deps.localPlayer).toEqual(['Tank']);
  });
});
