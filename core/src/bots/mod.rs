//! ИИ ботов: мозг (машина состояний) и его части. Ввод бот генерирует
//! теми же клавишами, что и игрок (`BotView::update_tank_keys`).
mod aim;
pub mod brain;
mod geom;
mod keys;
mod navigator;
mod perception;
pub mod profile;
mod steering;
pub mod team;
#[cfg(test)]
mod test_support;

pub use brain::BotBrain;
