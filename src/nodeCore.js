// В браузере и в Worker'е ядро грузится по URL .wasm-ассета
// (GameManifest.entries.wasm) через init() web-глюe. Headless-раннер
// движка (vimp-sim) работает в Node, где fetch() не умеет file:, и
// передаёт вместо ассета file:-URL nodejs-глюe (entries.wasmNode): там
// wasm подгружен самим модулем, init() не существует.
//
// Общий модуль для обеих половин плагина (host и client) — ветка выбора
// ядра обязана быть одинаковой, иначе headless-прогон пойдёт на разных
// сборках ядра.

/**
 * @param {string} [wasmUrl]
 * @returns {boolean} Это путь к nodejs-глюe, а не к .wasm-ассету.
 */
export const isNodeCore = wasmUrl => (wasmUrl ?? '').endsWith('.js');

/**
 * @param {string} wasmUrl - file:-URL nodejs-глюe (CommonJS).
 * @returns {Promise<Object>} Пространство имён модуля (GameCore/ClientCore).
 */
export const loadNodeCore = wasmUrl => import(/* @vite-ignore */ wasmUrl);
