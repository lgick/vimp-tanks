import fs from 'node:fs';

// Общий шаг ассет-сборки для copy-game-sounds.js и copy-game-images.js:
// каталог-источник целиком заменяет каждый из целевых каталогов (rm + cp,
// без слияния — иначе удалённый из assets/ файл остался бы в dist/ и уехал
// бы в тарбол). Отсутствие источника — ошибка сборки, а не пустой каталог:
// молча собранный пакет без картинок отрисовал бы пустое полотно.
//
// sourceDir, targetDirs — абсолютные пути; label — что именно копируется
// (для лога), hint — подсказка в тексте ошибки (какой шаг забыли).
export function copyAssetDir(sourceDir, targetDirs, { label, hint } = {}) {
  if (!fs.existsSync(sourceDir)) {
    console.error(`Error: '${sourceDir}' not found.${hint ? ` ${hint}` : ''}`);
    process.exit(1);
  }

  for (const targetDir of targetDirs) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });

    console.log(`copied ${label}: ${sourceDir} -> ${targetDir}`);
  }
}
