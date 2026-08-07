import TanksBotManager from './TanksBotManager.js';

// Фабрика игровых host-модулей (HostPlugin.createModules).
// ctx — движковый контекст: participants, coreAdapter, panel, stat, chat,
// socketManager, scripted.
export default function createModules(ctx) {
  return { scripted: new TanksBotManager(ctx) };
}
