import { describe, it, expect } from 'vitest';
import snapshot from '../../src/config/snapshot.js';
import * as fields from '../../src/client/snapshotFields.js';

// Кадр позиционен: индексы полей продублированы в схеме
// (src/config/snapshot.js), в константах клиента
// (src/client/snapshotFields.js) и в Rust-структурах ядра. Схема
// валидируется движком только по количеству и типам полей, поэтому
// разъехавшийся индекс молчит — этот тест закрывает JS-половину контракта.
describe('snapshotFields.js согласован со схемой snapshot.js', () => {
  // константа M1_GUN_ROTATION → поле gunRotation
  const nameOf = suffix =>
    suffix
      .toLowerCase()
      .replace(/_(.)/g, (_, char) => char.toUpperCase());

  // префикс константы → ключ схемы; c1/c2 делят одну форму (префикс C_)
  const blocks = { M1: 'm1', W1: 'w1', W2: 'w2', W2E: 'w2e', C: 'c1' };

  for (const [prefix, key] of Object.entries(blocks)) {
    it(`${key}: имя поля по индексу совпадает с суффиксом константы`, () => {
      const schemaFields = snapshot[key].fields;
      const constants = Object.entries(fields).filter(
        ([name]) => name.slice(0, name.indexOf('_')) === prefix,
      );

      expect(constants.length).toBeGreaterThan(0);

      for (const [name, index] of constants) {
        const expected = nameOf(name.slice(prefix.length + 1));

        // хвост сверх схемы дописывает клиентское ядро, по сети он не едет
        if (index >= schemaFields.length) {
          continue;
        }

        expect(schemaFields[index].name, `${name} = ${index}`).toBe(expected);
      }
    });
  }

  it('m1 несёт 2.5D-хвост целиком: z, level, vz, pitch, roll', () => {
    const names = snapshot.m1.fields.map(field => field.name);

    expect(names.slice(fields.M1_Z)).toEqual(['z', 'level', 'vz', 'pitch', 'roll']);
  });

  // `vz` — детектор касания, а не плавная величина: сглаженная выборка
  // точного нуля не даёт, и приземление чужого танка перестаёт
  // детектироваться (см. src/client/landing.js)
  it('vz не интерполируется', () => {
    expect(snapshot.m1.fields[fields.M1_VZ].interp).toBe('discrete');
    expect(snapshot.m1.fields[fields.M1_PITCH].interp).toBe('lerp');
    expect(snapshot.m1.fields[fields.M1_ROLL].interp).toBe('lerp');
  });
});
