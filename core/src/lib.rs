// VIMP Tanks — игровая симуляция (танки/оружие/боты) поверх
// vimp-engine-core + wasm-bindgen ABI (GameCore/ClientCore). Компилируется в
// WASM (браузер/Worker хоста и Node.js для тестов). Мета (раунды, чат,
// статистика, панель) остаётся на JS и управляет ядром командами, получая
// события через take_events().

use wasm_bindgen::prelude::*;

pub mod body_tag;
pub mod bomb;
pub mod bots;
pub mod client;
pub mod config;
pub mod level;
pub mod motion;
pub mod shot_levels;
pub mod tank;
pub mod tanks;

use client::ClientState;
use config::{RootClientConfig, RootConfig};
use serde::Serialize;
use tanks::GameState;
use vimp_engine_core::map::RampRun;
use vimp_engine_core::snapshot::SnapshotPacker;

/// Публичный ABI ядра для JS-оболочки (Worker хоста / тестовый харнесс).
#[wasm_bindgen]
pub struct GameCore {
    state: GameState,
    packer: SnapshotPacker,
}

#[wasm_bindgen]
impl GameCore {
    /// Создаёт ядро из JSON-конфига `{engine: {...}, game: {...}}`
    /// (собирается JS-оболочкой из game.js + models.js + weapons.js +
    /// opcodes.js, см. PLAN.md §3.4).
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<GameCore, JsError> {
        let cfg: RootConfig =
            serde_json::from_str(config_json).map_err(|e| JsError::new(&e.to_string()))?;

        cfg.engine.snapshot.validate().map_err(|e| JsError::new(&e))?;
        cfg.game.validate().map_err(|e| JsError::new(&e))?;

        let packer = SnapshotPacker::new(cfg.engine.snapshot.clone());

        Ok(GameCore {
            state: GameState::new(cfg.engine, &cfg.game),
            packer,
        })
    }

}

vimp_engine_core::export_game_core_abi!(GameCore);

impl GameCore {
    /// Доступ к состоянию для нативных тестов (не экспортируется в JS).
    pub fn state(&self) -> &GameState {
        &self.state
    }

    pub fn state_mut(&mut self) -> &mut GameState {
        &mut self.state
    }
}

/// Клиентский режим ядра (срез 2.6): интерполяция снапшотов, предикт
/// своего танка, визуальный спавн снарядов и распаковка кадров v3.
/// Живёт в главном потоке вкладки клиента; горячие позиции читаются
/// zero-copy плоским Float32-буфером, событийные кадры — JSON-строкой.
#[wasm_bindgen]
pub struct ClientCore {
    state: ClientState,
}

#[wasm_bindgen]
impl ClientCore {
    /// Создаёт клиентское ядро из JSON-конфига `{engine: {...}, game: {...}}`
    /// (собирается src/lib/clientCoreConfig.js из CONFIG_DATA + opcodes).
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<ClientCore, JsError> {
        let cfg: RootClientConfig =
            serde_json::from_str(config_json).map_err(|e| JsError::new(&e.to_string()))?;

        cfg.engine.snapshot.validate().map_err(|e| JsError::new(&e))?;

        Ok(ClientCore {
            state: ClientState::new(cfg.engine, &cfg.game),
        })
    }

    /// Локальный визуальный выстрел: гейты (кулдаун/патроны/pending-бомба/
    /// жив/активен) внутри. JSON спавна для applyGameData либо None.
    pub fn try_fire(&mut self, local_now: f64) -> Option<String> {
        self.state.try_action(local_now)
    }

    /// Локальный цикл смены оружия (авторитетное подтверждение — панелью).
    pub fn cycle_weapon(&mut self, back: bool) {
        self.state.cycle_item(back);
    }

    /// Модель танка пользователя (известна при авторизации).
    pub fn set_model(&mut self, model: &str) {
        self.state.set_model(model);
    }

    /// Авторитетное состояние панели (PANEL_DATA): патроны/активное оружие.
    pub fn sync_panel(&mut self, panel_json: &str) {
        self.state.sync_panel(panel_json);
    }

    /// Локальная точка тела → мировая в РЕНДЕРНОМ фрейме: `[x, y]` либо
    /// пустой массив (ключ неизвестен). Точку попадания считает симуляция,
    /// а рисуется она там, где ящик виден.
    pub fn map_dynamics_to_world(&self, key: &str, local_x: f32, local_y: f32) -> Vec<f32> {
        self.state
            .game()
            .map_dynamics()
            .and_then(|dynamics| dynamics.to_world(key, local_x, local_y))
            .map(|point| point.to_vec())
            .unwrap_or_default()
    }

    /// Прогоны рамп текущей карты для РЕНДЕРА клина: тот же
    /// `MapLevels::runs`, по которому физика ставит стражей. Второй обход
    /// грида на JS расходился бы с ядром молча — горка, которую видно и
    /// нельзя проехать.
    /// Формат: JSON-массив
    /// `{ axis, sign, from, to, min, max, crossMin, crossMax, block }`,
    /// координаты — МИРОВЫЕ (уже масштабированные), как в `RampRun`.
    /// Пустой массив — карты нет или она одноуровневая.
    pub fn ramp_runs(&self) -> String {
        let runs: Vec<RampRunView> = self
            .state
            .game()
            .levels()
            .map(|levels| levels.runs().iter().map(RampRunView::from).collect())
            .unwrap_or_default();

        serde_json::to_string(&runs).unwrap_or_else(|_| "[]".to_string())
    }
}

/// Прогон рампы за WASM-границей: те же поля, что у `RampRun` движка, но в
/// camelCase — по ту сторону их читает JS.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RampRunView {
    axis: u8,
    sign: i8,
    from: u8,
    to: u8,
    min: f32,
    max: f32,
    cross_min: f32,
    cross_max: f32,
    block: u16,
}

impl From<&RampRun> for RampRunView {
    fn from(run: &RampRun) -> Self {
        RampRunView {
            axis: run.axis,
            sign: run.sign,
            from: run.from,
            to: run.to,
            min: run.min,
            max: run.max,
            cross_min: run.cross_min,
            cross_max: run.cross_max,
            block: run.block,
        }
    }
}

vimp_engine_core::export_client_core_abi!(ClientCore);
