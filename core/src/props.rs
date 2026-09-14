//! Разрушаемые тела карты (пропы): забор, ящик, бочка. Проп — динамическое
//! тело карты, которому поле `physicsDynamic[i].game.prop` назначило тип из
//! `coreParams.props`. Модуль хранит HP и взведённые детонации; физику
//! (отключение тела, взрыв) и байт состояния ведёт `TanksSim`.
//!
//! Разрушенный проп не удаляется из мира: тело отключается, а состояние
//! живёт до следующей загрузки карты (`on_map_loaded` строит таблицу заново).

use serde::{Deserialize, Serialize};

use crate::config::PropRules;
use crate::map_game::PropGame;

/// Проп одного тела карты.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Prop {
    /// Индекс типа в `PropRules::types`.
    pub kind: usize,
    pub hp: f32,
    /// Шагов до детонации от чужого взрыва; `Some` — бочка взведена.
    pub pending_steps: Option<u32>,
}

impl Prop {
    /// HP кончился и детонация не ждёт: тело разрушено.
    pub fn is_destroyed(&self) -> bool {
        self.hp <= 0.0 && self.pending_steps.is_none()
    }
}

/// Пропы текущей карты; индекс = индекс `physicsDynamic`.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Props {
    pub entries: Vec<Option<Prop>>,
}

/// Причина урона: выбирает множитель и правило взведения бочки.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DamageCause {
    Bullet,
    Ram,
    Blast,
}

/// Результат урона по пропу.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PropTransition {
    /// Ничего не сменилось (урон по разрушенному, взведённому, неповреждающий).
    None,
    /// HP опустился ниже `damagedAt`: состояние `1`.
    Damaged,
    /// HP дошёл до нуля: тело разрушается (бочка — взрывается).
    Destroyed,
    /// Бочка от чужого взрыва: взорвётся через `chain_steps` шагов.
    Primed,
}

impl Props {
    /// Таблица пропов карты из `game` каждого тела (`GameMap::dynamic_game_data`).
    pub fn build(map: &vimp_engine_core::map::GameMap, rules: &PropRules) -> Result<Props, String> {
        Self::from_game_data((0..map.dynamic_body_count()).map(|index| map.dynamic_game_data(index)), rules)
    }

    /// То же по готовым сырым `game` тел: `None`/`Null` — тело без игровых
    /// данных. Неизвестное имя пропа — ошибка загрузки карты.
    pub fn from_game_data<'a>(
        data: impl Iterator<Item = Option<&'a serde_json::Value>>,
        rules: &PropRules,
    ) -> Result<Props, String> {
        let mut entries = Vec::new();

        for (index, value) in data.enumerate() {
            let game = match value {
                Some(value) if !value.is_null() => PropGame::deserialize(value)
                    .map_err(|err| format!("physicsDynamic[{index}].game: {err}"))?,
                _ => PropGame::default(),
            };
            let entry = match game.prop {
                Some(name) => {
                    let (kind, (_, prop)) = rules
                        .types
                        .iter()
                        .enumerate()
                        .find(|(_, (type_name, _))| **type_name == name)
                        .ok_or_else(|| format!("physicsDynamic[{index}].game.prop: unknown prop '{name}'"))?;

                    Some(Prop {
                        kind,
                        hp: prop.hp,
                        pending_steps: None,
                    })
                }
                None => None,
            };

            entries.push(entry);
        }

        Ok(Props { entries })
    }

    /// Есть ли на карте хоть один проп.
    pub fn is_empty(&self) -> bool {
        self.entries.iter().all(Option::is_none)
    }

    pub fn get(&self, index: usize) -> Option<&Prop> {
        self.entries.get(index).and_then(Option::as_ref)
    }

    /// Урон по пропу `index`. `amount` — сырой урон: множитель по причине
    /// применяется здесь (`Bullet` → `bulletFactor`, `Blast` → `blastFactor`,
    /// `Ram` → `1`, масштаб тарана уже в `ramDamagePerSpeed`). Разрушенный и
    /// взведённый проп урона не получают. Бочка (тип с `blast`), чей HP дошёл
    /// до нуля от `Blast`, взводится на `chain_steps[kind]` шагов и
    /// возвращает `Primed`; от `Bullet`/`Ram` — `Destroyed`.
    pub fn damage(
        &mut self,
        index: usize,
        amount: f32,
        cause: DamageCause,
        rules: &PropRules,
        chain_steps: &[u32],
    ) -> PropTransition {
        let Some(prop) = self.entries.get_mut(index).and_then(Option::as_mut) else {
            return PropTransition::None;
        };

        if prop.hp <= 0.0 || prop.pending_steps.is_some() {
            return PropTransition::None;
        }

        let Some(rule) = rules.types.values().nth(prop.kind) else {
            return PropTransition::None;
        };
        let factor = match cause {
            DamageCause::Bullet => rule.bullet_factor,
            DamageCause::Blast => rule.blast_factor,
            DamageCause::Ram => 1.0,
        };
        let dealt = amount * factor;

        if !(dealt > 0.0) {
            return PropTransition::None;
        }

        let before = prop.hp;

        prop.hp = (prop.hp - dealt).max(0.0);

        if prop.hp <= 0.0 {
            if rule.blast.is_some() && cause == DamageCause::Blast {
                prop.pending_steps = Some(chain_steps.get(prop.kind).copied().unwrap_or(1).max(1));

                return PropTransition::Primed;
            }

            return PropTransition::Destroyed;
        }

        let threshold = rule.hp * rule.damaged_at;

        if rule.damaged_at > 0.0 && prop.hp < threshold && before >= threshold {
            PropTransition::Damaged
        } else {
            PropTransition::None
        }
    }

    /// Шаг взведённых детонаций; индексы бочек, которым пора взорваться, —
    /// по возрастанию. Счётчик, уже стоящий на нуле, срабатывает, иначе
    /// уменьшается: бочка, взведённая в этом же шаге (бомбой до вызова или
    /// соседней бочкой после), никогда не взрывается в том же шаге.
    pub fn tick_detonations(&mut self) -> Vec<usize> {
        let mut fired = Vec::new();

        for (index, entry) in self.entries.iter_mut().enumerate() {
            let Some(prop) = entry.as_mut() else {
                continue;
            };
            let Some(steps) = prop.pending_steps else {
                continue;
            };

            if steps == 0 {
                prop.pending_steps = None;
                fired.push(index);
            } else {
                prop.pending_steps = Some(steps - 1);
            }
        }

        fired
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules() -> PropRules {
        serde_json::from_value(json!({
            "fence": { "hp": 30, "ramThreshold": 60, "ramDamagePerSpeed": 0.5 },
            "crate": { "hp": 120, "damagedAt": 0.5, "bulletFactor": 0.5, "blastFactor": 1.5, "ramThreshold": 140, "ramDamagePerSpeed": 0.6 },
            "barrel": { "hp": 40, "chainDelay": 0.15,
                "blast": { "radius": 70, "damage": 80, "impulse": 2500000 } }
        }))
        .unwrap()
    }

    const STEPS: [u32; 3] = [3, 1, 1];

    fn props(names: &[Option<&str>]) -> Props {
        let data: Vec<serde_json::Value> = names
            .iter()
            .map(|name| name.map_or(serde_json::Value::Null, |name| json!({ "prop": name })))
            .collect();

        Props::from_game_data(data.iter().map(Some), &rules()).unwrap()
    }

    #[test]
    fn build_assigns_kinds_and_skips_plain_bodies() {
        let props = props(&[Some("fence"), None, Some("barrel")]);

        assert_eq!(props.entries[0], Some(Prop { kind: 2, hp: 30.0, pending_steps: None }));
        assert_eq!(props.entries[1], None);
        assert_eq!(props.entries[2].as_ref().unwrap().kind, 0);
        assert!(!props.is_empty());
        assert!(Props::default().is_empty());
    }

    #[test]
    fn unknown_prop_is_an_error() {
        let data = [json!({ "prop": "tree" })];
        let error = Props::from_game_data(data.iter().map(Some), &rules()).unwrap_err();

        assert!(error.contains("physicsDynamic[0].game.prop") && error.contains("tree"), "{error}");
    }

    #[test]
    fn same_raw_damage_depends_on_the_cause() {
        let rules = rules();
        let hp_after = |cause| {
            let mut props = props(&[Some("crate")]);

            props.damage(0, 20.0, cause, &rules, &STEPS);
            props.entries[0].as_ref().unwrap().hp
        };

        assert_eq!(hp_after(DamageCause::Bullet), 110.0);
        assert_eq!(hp_after(DamageCause::Blast), 90.0);
        assert_eq!(hp_after(DamageCause::Ram), 100.0);
    }

    #[test]
    fn crate_passes_the_damaged_stage_once_then_breaks() {
        let rules = rules();
        let mut props = props(&[Some("crate")]);
        // пуля 40 × 0.5 = 20 HP; порог стадии — 60
        let transitions: Vec<PropTransition> = (0..6)
            .map(|_| props.damage(0, 40.0, DamageCause::Bullet, &rules, &STEPS))
            .collect();

        assert_eq!(
            transitions,
            [
                PropTransition::None,
                PropTransition::None,
                PropTransition::None,
                PropTransition::Damaged,
                PropTransition::None,
                PropTransition::Destroyed,
            ]
        );
        assert!(props.entries[0].as_ref().unwrap().is_destroyed());
        assert_eq!(props.damage(0, 40.0, DamageCause::Bullet, &rules, &STEPS), PropTransition::None);
    }

    #[test]
    fn fence_without_a_stage_breaks_straight_away() {
        let rules = rules();
        let mut props = props(&[Some("fence")]);

        assert_eq!(props.damage(0, 10.0, DamageCause::Bullet, &rules, &STEPS), PropTransition::None);
        assert_eq!(props.damage(0, 20.0, DamageCause::Blast, &rules, &STEPS), PropTransition::Destroyed);
        assert_eq!(props.damage(0, 0.0, DamageCause::Ram, &rules, &STEPS), PropTransition::None);
    }

    #[test]
    fn only_a_barrel_hit_by_a_blast_is_primed() {
        let rules = rules();
        let mut shot = props(&[Some("barrel")]);
        let mut rammed = props(&[Some("barrel")]);
        let mut blasted = props(&[Some("barrel"), Some("fence")]);

        assert_eq!(shot.damage(0, 40.0, DamageCause::Bullet, &rules, &STEPS), PropTransition::Destroyed);
        assert_eq!(rammed.damage(0, 40.0, DamageCause::Ram, &rules, &STEPS), PropTransition::Destroyed);
        assert_eq!(blasted.damage(0, 40.0, DamageCause::Blast, &rules, &STEPS), PropTransition::Primed);
        assert_eq!(blasted.damage(1, 40.0, DamageCause::Blast, &rules, &STEPS), PropTransition::Destroyed);

        let primed = blasted.entries[0].as_ref().unwrap();

        assert_eq!(primed.pending_steps, Some(3));
        assert!(!primed.is_destroyed());
        // взведённая бочка урона больше не получает и не перевзводится
        assert_eq!(blasted.damage(0, 40.0, DamageCause::Bullet, &rules, &STEPS), PropTransition::None);
        assert_eq!(blasted.damage(0, 40.0, DamageCause::Blast, &rules, &STEPS), PropTransition::None);
        assert_eq!(blasted.entries[0].as_ref().unwrap().pending_steps, Some(3));
    }

    #[test]
    fn detonations_fire_in_index_order_never_on_the_priming_step() {
        let rules = rules();
        let mut props = props(&[Some("barrel"), Some("crate"), Some("barrel")]);

        props.damage(2, 40.0, DamageCause::Blast, &rules, &STEPS);
        props.damage(0, 40.0, DamageCause::Blast, &rules, &STEPS);

        let fired: Vec<Vec<usize>> = (0..5).map(|_| props.tick_detonations()).collect();

        assert_eq!(fired, [vec![], vec![], vec![], vec![0, 2], vec![]]);
        assert!(props.entries[0].as_ref().unwrap().is_destroyed());
        assert!(props.entries[2].as_ref().unwrap().is_destroyed());
    }
}
