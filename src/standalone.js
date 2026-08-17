// Точка входа локального автономного запуска (`npm run dev`): матч против
// ботов прямо во вкладке — без мастера, без OAuth и без экрана лобби.
// В сборку плагина (`npm run build`, --mode client|host) этот файл не
// попадает и в npm-пакет не публикуется (`files: ["dist"]`).
import 'vimp-engine/style.css';
import './client/tanks.css';
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from './host/index.js';
import clientPlugin from './client/index.js';
import wasmUrl from '../core/pkg-web/vimp_tanks_core_bg.wasm?url';

await startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container: document.getElementById('game'),
  // звуки в dev лежат в build/sounds (продукт `npm run audio:process`);
  // SDK читает их как `${assetsBase}sounds/`
  assetsBase: '/build/',
  playerName: localStorage.getItem('vimp_dev_nick') || 'Tanker',
  playerModel: 'm1',
  // сначала выйти из наблюдателей, только потом просить ботов: handler
  // /bot отбивает команду наблюдателю (BOT_PLAYERS_ONLY), а новый участник
  // входит именно наблюдателем
  startupVotes: [['teamChange', 'team1']],
  startupCommands: ['/bot 4'],
  room: { map: 'pool mini' },
  devMode: true,
});
