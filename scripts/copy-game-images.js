import { fileURLToPath } from 'node:url';
import { copyAssetDir } from './lib/copyAssetDir.js';

// Раскладывает картинки игры (тайл-листы карт и спрайты динамических тел)
// из assets/img/ по двум потребителям:
//
//   build/img/ — dev-корень автономного запуска (npm run dev): SDK получает
//                assetsBase '/build/', то есть тайл лежит по /build/img/<file>
//   dist/img/  — ассет пакета под GameManifest.assetsBase: мастер монтирует
//                dist/ игры на /games/<id>/, то есть /games/tanks/img/<file>
//
// Обработки у картинок нет (в отличие от звуков с их ffmpeg-нормализацией в
// npm run audio:process), поэтому промежуточной стадии не требуется и оба
// таргета пишутся за один прогон. Запись в dist/ из predev безопасна:
// npm run build начинается с rm -rf dist.
//
// Запуск: node scripts/copy-game-images.js (build:assets и predev)

const sourceDir = fileURLToPath(new URL('../assets/img/', import.meta.url));
const targetDirs = [
  fileURLToPath(new URL('../build/img/', import.meta.url)),
  fileURLToPath(new URL('../dist/img/', import.meta.url)),
];

copyAssetDir(sourceDir, targetDirs, { label: 'images' });
