import { mkdir, writeFile } from 'node:fs/promises';
import maps from '../src/data/maps/index.js';

// Экспорт карт из JS-модулей (src/data/maps/*.js) в статичные
// .json — формат загрузки load_map Rust-ядра (core/) и раздачи карт
// мастер-сервером без пересборки клиента/хоста (GameManifest.maps, Этап 6.2:
// GameCatalog мастера монтирует dist/games/tanks/maps/ на /games/tanks/maps/).
// Запуск: npm run maps:export → dist/maps/<имя>.json

const outDir = new URL('../dist/maps/', import.meta.url);

await mkdir(outDir, { recursive: true });

for (const [name, map] of Object.entries(maps)) {
  // конструктор URL кодирует пробелы, fs декодирует их обратно
  const file = new URL(`${name}.json`, outDir);

  await writeFile(file, JSON.stringify(map));
  console.log(`exported: ${name}.json`);
}
