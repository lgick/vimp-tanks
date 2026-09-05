import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execPromise = promisify(exec);

const soundsDir = 'build/sounds';

// кодеки, которые собирает scripts/process-audio.js: сравниваются попарно
const CODECS = ['mp3', 'webm'];

// целевая интегральная громкость: та же, что в scripts/process-audio.js
// (LOUDNESS.I). Правка там обязана править и это число
const TARGET_I = -16;

// расхождение между кодеками одного звука. Это и есть критерий: mp3 играет
// Safari, webm — все остальные, и один и тот же звук обязан звучать
// одинаково громко в любом браузере
const CODEC_TOLERANCE = 1;

// отклонение от цели, при котором печатается предупреждение (без ошибки).
// Точно попасть в цель однопроходный loudnorm может не всегда: у звука с
// большим LRA (`shot` — 26 LU против цели 7) фильтр сначала сжимает
// динамику, и интегральная громкость уезжает
const TARGET_WARN = 2;

// ebur128 не измеряет интегральную громкость файла короче окна гейтинга
// (400 мс) — там она выходит -70 LUFS и смысла не несёт
const UNMEASURABLE_I = -69;

// проверка установки ffmpeg
async function isFfmpegInstalled() {
  try {
    await execPromise('ffmpeg -version');
    return true;
  } catch (error) {
    return false;
  }
}

// интегральная громкость файла (LUFS) через фильтр ebur128
async function measureLoudness(filePath) {
  // ebur128 печатает сводку в stderr; сам звук никуда не пишется
  const { stderr } = await execPromise(
    `ffmpeg -nostdin -hide_banner -i "${filePath}" -af ebur128 -f null -`,
    { maxBuffer: 32 * 1024 * 1024 },
  );

  // сводка в конце вывода: "Integrated loudness:\n    I:  -16.0 LUFS"
  const summaryAt = stderr.lastIndexOf('Integrated loudness:');

  if (summaryAt === -1) {
    return null;
  }

  const match = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(stderr.slice(summaryAt));

  return match ? Number(match[1]) : null;
}

function format(loudness) {
  if (loudness === null) {
    return '    n/a';
  }

  return loudness <= UNMEASURABLE_I ? '  short' : loudness.toFixed(1);
}

async function main() {
  console.log('--- Checking Audio Levels ---');

  if (!(await isFfmpegInstalled())) {
    console.error('Error: ffmpeg is not installed.');
    process.exit(1);
  }

  let files;

  try {
    files = await fs.readdir(soundsDir);
  } catch (error) {
    console.error(
      `Error: Directory '${soundsDir}' not found. ` +
        "Run 'npm run audio:process' first.",
    );
    process.exit(1);
  }

  // имена звуков: по одному на пару mp3/webm
  const names = [
    ...new Set(
      files
        .filter(file => CODECS.includes(path.extname(file).slice(1)))
        .map(file => path.basename(file, path.extname(file))),
    ),
  ].sort();

  if (names.length === 0) {
    console.error(`Error: No audio files in '${soundsDir}'.`);
    process.exit(1);
  }

  console.log(
    `> Target: I = ${TARGET_I} LUFS; ` +
      `codecs must agree within ${CODEC_TOLERANCE} LU\n`,
  );
  console.log(`   ${'sound'.padEnd(26)}${'mp3'.padStart(7)}` +
    `${'webm'.padStart(8)}${'spread'.padStart(9)}`);

  let failed = 0;

  for (const name of names) {
    const measured = {};

    for (const codec of CODECS) {
      measured[codec] = await measureLoudness(
        path.join(soundsDir, `${name}.${codec}`),
      );
    }

    const values = CODECS.map(codec => measured[codec]);
    const comparable = values.every(
      value => value !== null && value > UNMEASURABLE_I,
    );
    const spread = comparable ? Math.max(...values) - Math.min(...values) : 0;
    const missing = values.some(value => value === null);
    const ok = !missing && (!comparable || spread <= CODEC_TOLERANCE);
    const notes = [];

    if (missing) {
      notes.push('measurement failed');
    } else if (!comparable) {
      notes.push('too short to measure');
    } else if (Math.abs(values[0] - TARGET_I) > TARGET_WARN) {
      notes.push(`⚠️  ${(values[0] - TARGET_I).toFixed(1)} LU off target`);
    }

    console.log(
      `${ok ? '✅' : '❌'} ${name.padEnd(26)}` +
        `${format(measured.mp3).padStart(7)}` +
        `${format(measured.webm).padStart(8)}` +
        `${(comparable ? spread.toFixed(1) : '—').padStart(9)}` +
        (notes.length ? `  ${notes.join(', ')}` : ''),
    );

    if (!ok) {
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} sound(s) differ between codecs.`);
    process.exit(1);
  }

  console.log('\n🎉 Codecs agree on every sound.');
}

main().catch(err => {
  console.error('\nCritical script error:', err);
  process.exit(1);
});
