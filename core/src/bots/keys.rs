//! Клавиши бота: удержание, одиночные нажатия, отпускание.

use serde::{Deserialize, Serialize};

use crate::tanks::BotView;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub(crate) enum HeldKey {
    Forward,
    Back,
    Left,
    Right,
    GunLeft,
    GunRight,
}

const HELD_KEYS: [HeldKey; 6] = [
    HeldKey::Forward,
    HeldKey::Back,
    HeldKey::Left,
    HeldKey::Right,
    HeldKey::GunLeft,
    HeldKey::GunRight,
];

/// Удерживаемые клавиши бота. Событие в ядро уходит только при смене
/// состояния (как у игрока: один keydown, один keyup).
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct KeyPad {
    pub(super) states: [bool; 6],
    /// Синхронизирован ли пульт с танком. После `deserialize` false:
    /// первым делом отпускаются ВСЕ клавиши принудительно, иначе клавиша,
    /// зажатая в дампе танка, никогда бы не отпустилась.
    #[serde(skip)]
    pub(super) synced: bool,
}

fn index(key: HeldKey) -> usize {
    HELD_KEYS.iter().position(|&k| k == key).unwrap()
}

/// Бит клавиши в раскладке игрока.
fn key_bit(game: &BotView<'_>, key: HeldKey) -> u32 {
    let bits = &game.key_bits;

    match key {
        HeldKey::Forward => bits.forward,
        HeldKey::Back => bits.back,
        HeldKey::Left => bits.left,
        HeldKey::Right => bits.right,
        HeldKey::GunLeft => bits.gun_left,
        HeldKey::GunRight => bits.gun_right,
    }
}

impl KeyPad {
    pub(crate) fn synced(&self) -> bool {
        self.synced
    }

    /// Обновляет клавишу только при изменении состояния (JS _setKeyState).
    pub(crate) fn set(&mut self, game: &mut BotView<'_>, id: u32, key: HeldKey, down: bool) {
        let index = index(key);

        if self.states[index] != down {
            self.states[index] = down;

            let bit = key_bit(game, key);
            let action = if down { "down" } else { "up" };

            game.update_tank_keys(id, action, bit);
        }
    }

    pub(crate) fn release_all(&mut self, game: &mut BotView<'_>, id: u32) {
        for key in HELD_KEYS {
            self.set(game, id, key, false);
        }
    }

    /// Отпускает клавиши движения (Forward/Back/Left/Right).
    pub(crate) fn release_movement(&mut self, game: &mut BotView<'_>, id: u32) {
        for key in [
            HeldKey::Forward,
            HeldKey::Back,
            HeldKey::Left,
            HeldKey::Right,
        ] {
            self.set(game, id, key, false);
        }
    }

    /// Отпускает клавиши башни (GunLeft/GunRight).
    pub(crate) fn release_gun(&mut self, game: &mut BotView<'_>, id: u32) {
        self.set(game, id, HeldKey::GunLeft, false);
        self.set(game, id, HeldKey::GunRight, false);
    }

    /// Одиночное нажатие (огонь, смена оружия): ядро само гасит его после
    /// обработки.
    pub(crate) fn press_once(&self, game: &mut BotView<'_>, id: u32, bit: u32) {
        game.update_tank_keys(id, "down", bit);
    }

    pub(crate) fn is_down(&self, key: HeldKey) -> bool {
        self.states[index(key)]
    }

    /// Шлёт `"up"` всех шести клавиш без оглядки на `states` и считает
    /// пульт синхронизированным.
    pub(crate) fn force_release_all(&mut self, game: &mut BotView<'_>, id: u32) {
        for key in HELD_KEYS {
            let bit = key_bit(game, key);

            game.update_tank_keys(id, "up", bit);
        }

        self.states = [false; 6];
        self.synced = true;
    }
}
