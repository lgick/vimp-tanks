// Индексы полей в строках снапшота: порядок задаёт src/config/snapshot.js
// (`fields` каждой схемы), а хост пишет строки в том же порядке —
// `TankRow`/`TracerRow`/`BombRow`/`ExplosionRow` в core/src/tanks.rs и
// core/src/bomb.rs. Правка схемы обязана править и эти константы: кадр
// позиционен, ошибиться индексом молча очень легко.
//
// m1 — танк (hot, интерполируется движком между кадрами)
export const M1_X = 0;
export const M1_Y = 1;
export const M1_ANGLE = 2;
export const M1_GUN_ROTATION = 3;
export const M1_VX = 4;
export const M1_VY = 5;
export const M1_ENGINE_LOAD = 6;
export const M1_CONDITION = 7;
export const M1_SIZE = 8;
export const M1_TEAM = 9;
export const M1_ANGVEL = 10;
export const M1_Z = 11;
export const M1_LEVEL = 12;
export const M1_VZ = 13;
export const M1_PITCH = 14;
export const M1_ROLL = 15;

// w1 — трассер выстрела (event)
export const W1_START_X = 0;
export const W1_START_Y = 1;
export const W1_END_X = 2;
export const W1_END_Y = 3;
export const W1_BODY_X = 4;
export const W1_BODY_Y = 5;
export const W1_WAS_HIT = 6;
export const W1_SHOOTER_ID = 7;
export const W1_START_LEVEL = 8;
export const W1_END_LEVEL = 9;
// хвост сверх схемы: якорь попадания, который дописывает клиентское ядро
// (core/src/client/mod.rs) — по сети он не едет
export const W1_ANCHOR = 10;

// w2 — бомба (event)
export const W2_X = 0;
export const W2_Y = 1;
export const W2_ANGLE = 2;
export const W2_SIZE = 3;
export const W2_TIME = 4;
export const W2_OWNER_ID = 5;
export const W2_LEVEL = 6;

// w2e — взрыв (event)
export const W2E_X = 0;
export const W2E_Y = 1;
export const W2E_RADIUS = 2;
export const W2E_LEVEL = 3;

// c1/c2 — динамика карты (hot): схемы совпадают по форме
export const C_X = 0;
export const C_Y = 1;
export const C_ANGLE = 2;
export const C_Z = 3;
export const C_LEVEL = 4;
export const C_VX = 5;
export const C_VY = 6;
export const C_ANGVEL = 7;
