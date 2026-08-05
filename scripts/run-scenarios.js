import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Прогон всех отладочных сценариев (tests/scenarios/*.json) на движковом
// headless-раннере поверх собранного плагина (dist/manifest.json +
// core/pkg-node). Один вердикт на все сценарии: код возврата 1, если хоть
// в одном нарушен инвариант. Ставится в CI рядом с обычными тестами —
// сценарии ловят класс отказов, которого нет в юнит-тестах (пустая сцена,
// перепутанные поля схемы, дрейф предикта).
//
// --determinism включает самопроверку (каждый сценарий гоняется дважды и
// потоки кадров сравниваются побайтово).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenarioDir = path.join(root, 'tests', 'scenarios');
const sim = path.join(root, 'node_modules', 'vimp-engine', 'bin', 'vimp-sim.js');
const extraArgs = process.argv.slice(2);

const scenarios = readdirSync(scenarioDir)
  .filter(name => name.endsWith('.json'))
  .sort();

if (!scenarios.length) {
  console.error(`no scenarios in ${scenarioDir}`);
  process.exit(1);
}

const failed = [];

for (const name of scenarios) {
  const result = spawnSync(
    process.execPath,
    [
      sim,
      '--game',
      root,
      '--scenario',
      path.join(scenarioDir, name),
      '--no-write',
      ...extraArgs,
    ],
    { cwd: root, encoding: 'utf8' },
  );

  // из полного отчёта в лог CI идёт только блок инвариантов — вердикт
  // читаемый, а не тысяча строк сцены
  const invariants = (result.stdout ?? '')
    .split('## Invariants')[1]
    ?.split('##')[0]
    ?.trim();

  console.log(`\n=== ${name} ===\n${invariants ?? result.stdout}`);

  if (result.stderr) {
    console.error(result.stderr.trim());
  }

  if (result.status !== 0) {
    failed.push(name);
  }
}

if (failed.length) {
  console.error(`\nscenarios with broken contracts: ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`\nall ${scenarios.length} scenario(s) green`);
