import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import init, { ClientCore } from '../../core/pkg-web/vimp_tanks_core.js';
// игровой CSS (панель/полотна/команды) как строка — движок сам вставляет
// его в DOM (поле styles контракта); ?inline не даёт Vite auto-inject
// <style> при сборке (см. vite.config.js — сборка без index.html)
import styles from './tanks.css?inline';
import parts from './parts/index.js';
import bakers from './bakers/index.js';
import { isNodeCore, loadNodeCore } from '../nodeCore.js';

// ClientPlugin танков: рендеры сущностей (parts), процедурные текстуры
// (bakers) и игровые хуки клиентского ядра (ClientCore). default export
// client-entry игры (vite.config.js --mode client, Этап 6.1);
// грузится динамически по GameManifest мастера (Этап 6.3, main.js).
// Движок (main.js) не знает игровых методов ядра —
// set_model/sync_panel/try_fire/cycle_weapon зовутся только отсюда.
export default {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,

  // wasmUrl — из GameManifest.entries.wasm (общий с host-плагином ассет)
  async createClientCore(clientConfigJson, { wasmUrl }) {
    // node-сборка ядра (headless-раннер): памяти WASM наружу нет и она не
    // нужна — hot читается копией (hot_values), а не вьюхой
    if (isNodeCore(wasmUrl)) {
      const node = await loadNodeCore(wasmUrl);

      return { core: new node.ClientCore(clientConfigJson), memory: null };
    }

    // eslint-disable-next-line camelcase -- wasm-bindgen init() option name
    const wasm = await init({ module_or_path: wasmUrl });

    return { core: new ClientCore(clientConfigJson), memory: wasm.memory };
  },

  parts,
  bakers,
  styles,
  hooks: {
    // сервисы игры для её же parts (движок их не описывает — только раздаёт
    // тем, кто объявил их в componentDependencies, см. src/config/client.js).
    // mapDynamics — геометрия предсказанной динамики карты из ядра: по ней
    // ShotEffect пересчитывает точку удара по ТЕКУЩЕМУ трансформу ящика
    services(core) {
      return {
        mapDynamics: {
          // локальная точка тела → мировая в рендерном фрейме;
          // null — ключ неизвестен (карта сменилась, ящика больше нет)
          toWorld(key, localX, localY) {
            const point = core.map_dynamics_to_world(key, localX, localY);

            return point.length === 0 ? null : { x: point[0], y: point[1] };
          },
        },
      };
    },

    // авторизация: модель танка пользователя — для реплик движения и выстрелов
    onAuth(core, authData) {
      core.set_model(authData.model);
    },

    // кадр панели: зеркало боезапаса/активного оружия для гейтов try_fire
    onPanel(core, panelData) {
      core.sync_panel(JSON.stringify(panelData));
    },

    // локальное действие игрока; возвращает JSON спавна выстрела либо null.
    // Гейты в ядре: предикт активен, свой танк жив, хватает боезапаса
    onLocalAction(core, action, name, now) {
      if (action !== 'down') {
        return null;
      }

      if (name === 'fire') {
        return core.try_fire(now) || null;
      }

      if (name === 'nextWeapon' || name === 'prevWeapon') {
        core.cycle_weapon(name === 'prevWeapon');
      }

      return null;
    },
  },
};
