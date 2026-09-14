//! Игровые данные карты: поле `game` в JSON карты и `game` элементов
//! `physicsDynamic`. Движок хранит их сырым JSON (`GameMap::game_data`,
//! `GameMap::dynamic_game_data`), смысл полей задаёт игра. Разбирается
//! одинаково на хосте (`TanksSim`) и на клиенте (`ClientMapConfig`).
//!
//! Ядро разбирает только то, что влияет на симуляцию. Клиентские поля
//! (`lighting`, `animatedTiles`, `signs`, `decals`) serde молча отбрасывает.

use std::collections::BTreeMap;

use serde::Deserialize;
use vimp_engine_core::map::MapLevels;

use crate::config::SurfaceRules;

/// Поле `game` карты.
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MapGame {
    /// уровень ("0", "1", …) → id тайла ("41") → описание поверхности
    pub surfaces: BTreeMap<String, BTreeMap<String, SurfaceTileDef>>,
}

/// Поле `game` элемента `physicsDynamic`.
#[derive(Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PropGame {
    /// игровой тип тела карты (`fence`, `crate`, `barrel`)
    pub prop: Option<String>,
}

/// Описание поверхности тайла: краткое имя (`"sand"`) или полная форма с
/// направлением (`{ "type": "booster", "dir": "e" }`). Заглушка: смысл
/// поверхностей появится вместе с их физикой.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum SurfaceTileDef {
    Name(String),
    Full {
        r#type: String,
        #[serde(default)]
        dir: Option<String>,
    },
}

/// `null` в JSON — то же, что отсутствующее поле: клиент движка передаёт
/// `game` карты как есть, и у карты без него приходит `null`.
pub fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

impl MapGame {
    /// Разбор сырого `game` карты. `Null` (карта поле не объявила) — пустые
    /// данные. Ошибка несёт путь до поля, на котором разбор сломался.
    pub fn from_value(value: &serde_json::Value) -> Result<Self, String> {
        if value.is_null() {
            return Ok(Self::default());
        }

        Self::deserialize(value).map_err(|err| format!("map game: {err}"))
    }

    /// Проверка `game.surfaces` при загрузке карты — одна функция на хост
    /// (`on_map_loaded`) и клиента (`set_map`): уровень существует, тип
    /// объявлен в `coreParams.surfaces.types`, `dir` задан ровно у
    /// направленных типов, тайл не стена (`physicsStatic`/`walls`) и не
    /// рампа своего уровня.
    pub fn validate_surfaces(&self, rules: &SurfaceRules, levels: &MapLevels) -> Result<(), String> {
        let tile_size = levels.tile_size();

        for resolved in crate::surface::resolve_tiles(self, rules, levels.level_count())? {
            let (level, tile, name) = (resolved.level, resolved.tile, &resolved.name);

            if levels.solid(level).contains(&tile) {
                return Err(format!(
                    "game.surfaces.{level}.{tile}: the tile is a wall and cannot carry surface '{name}'"
                ));
            }

            let Some(grid) = levels.grid(level) else {
                continue;
            };

            // тайл рампы лежит в гриде уровня `from` (`RampConfig::tile`)
            for (cy, row) in grid.iter().enumerate() {
                for (cx, &cell) in row.iter().enumerate() {
                    let x = (cx as f32 + 0.5) * tile_size;
                    let y = (cy as f32 + 0.5) * tile_size;

                    if cell == tile && levels.ramp_at(x, y).is_some_and(|ramp| ramp.from == level) {
                        return Err(format!(
                            "game.surfaces.{level}.{tile}: the tile is a ramp and cannot carry surface '{name}'"
                        ));
                    }
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_and_empty_game_parse_to_default() {
        assert_eq!(MapGame::from_value(&serde_json::Value::Null), Ok(MapGame::default()));
        assert_eq!(MapGame::from_value(&json!({})), Ok(MapGame::default()));
    }

    #[test]
    fn full_game_parses_both_surface_forms() {
        let game = MapGame::from_value(&json!({
            "surfaces": {
                "0": { "41": "sand", "42": { "type": "booster", "dir": "e" } },
                "1": { "7": { "type": "oil" } }
            }
        }))
        .unwrap();

        assert_eq!(game.surfaces["0"]["41"], SurfaceTileDef::Name("sand".to_string()));
        assert_eq!(
            game.surfaces["0"]["42"],
            SurfaceTileDef::Full {
                r#type: "booster".to_string(),
                dir: Some("e".to_string()),
            }
        );
        assert_eq!(
            game.surfaces["1"]["7"],
            SurfaceTileDef::Full {
                r#type: "oil".to_string(),
                dir: None,
            }
        );
    }

    #[test]
    fn unknown_keys_are_ignored() {
        let game = MapGame::from_value(&json!({
            "lighting": { "ambient": 0.2 },
            "animatedTiles": [],
            "signs": [],
            "decals": []
        }))
        .unwrap();

        assert_eq!(game, MapGame::default());
    }

    #[test]
    fn broken_game_is_an_error() {
        // пустой массив serde принимает за структуру из дефолтов; его
        // отклоняет движок (`MapConfig::validate`) ещё до игры
        assert!(MapGame::from_value(&json!("sand")).is_err());
        assert!(MapGame::from_value(&json!({ "surfaces": { "0": { "41": 5 } } })).is_err());
    }

    #[test]
    fn prop_game_parses_and_defaults() {
        let prop: PropGame = serde_json::from_value(json!({ "prop": "barrel", "hp": 3 })).unwrap();

        assert_eq!(prop.prop.as_deref(), Some("barrel"));
        assert_eq!(serde_json::from_value::<PropGame>(json!({})).unwrap(), PropGame::default());
    }
}
