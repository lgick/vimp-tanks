//! Доска команды: где союзники (и боты, и люди), общий фокус, роли ботов,
//! центр группы. Производная структура: в дамп не едет, пересобирается
//! `TanksSim::rebuild_team_boards` раз в 0.1 с.

use serde::Serialize;

use super::brain::BotMode;
use super::geom::dist;

/// Держать прежний фокус не меньше, с.
const FOCUS_HOLD: f32 = 3.0;
/// Новый фокус должен быть лучше прежнего во столько раз.
const FOCUS_SWITCH_RATIO: f32 = 1.3;
/// Роли раздаются раз в, с.
const ROLES_INTERVAL: f32 = 2.0;
/// Ниже этого здоровья бот — `Support`.
const SUPPORT_HEALTH: f32 = 50.0;

/// Роль бота в команде.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Role {
    Assault,
    Flanker,
    Support,
}

#[derive(Clone, Copy, Debug)]
pub struct Member {
    pub id: u32,
    pub pos: [f32; 2],
    pub level: u8,
    /// Доля «силы» по видимому состоянию корпуса: condition 3 → 1.0, 2 → 0.6,
    /// 1 → 0.3. Здоровья союзника игрок не видит, видит только корпус.
    pub strength: f32,
    pub is_bot: bool,
    /// Режим и цель бота (у людей `None`).
    pub mode: Option<BotMode>,
    pub target: Option<u32>,
}

/// Живой враг — кандидат в фокус.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Enemy {
    pub id: u32,
    pub pos: [f32; 2],
    pub condition: u8,
}

/// Что доске нужно знать о боте команды.
#[derive(Clone, Debug)]
pub(crate) struct BotInfo {
    pub id: u32,
    /// Своё здоровье бот знает.
    pub health: f32,
    pub aggression: f32,
    /// Видимые боту враги (`perception.contacts` с `visible`).
    pub sees: Vec<u32>,
}

/// Общие сведения команды на текущий тик ИИ. Производная структура: в дамп не
/// едет, пересобирается `TanksSim::rebuild_team_boards` раз в 0.1 с.
#[derive(Clone, Debug, Default)]
pub struct TeamBoard {
    pub team: u8,
    /// По возрастанию id.
    pub members: Vec<Member>,
    pub centroid: Option<[f32; 2]>,
    pub focus: Option<u32>,
    focus_score: f32,
    focus_since: f32,
    /// Только боты, по возрастанию id.
    pub roles: Vec<(u32, Role)>,
    roles_at: Option<f32>,
    /// Враги, которых сейчас видит хотя бы один бот команды: (id, сколько видят).
    pub sightings: Vec<(u32, u8)>,
}

/// «Сила» танка по видимому состоянию корпуса.
pub(crate) fn strength_of(condition: u8) -> f32 {
    match condition {
        3 => 1.0,
        2 => 0.6,
        1 => 0.3,
        _ => 0.0,
    }
}

impl TeamBoard {
    /// Пересборка доски. `members` — живые танки команды, `enemies` — живые
    /// враги, `bots` — живые боты команды; все по возрастанию id.
    pub(crate) fn update(
        &mut self,
        team: u8,
        members: Vec<Member>,
        enemies: &[Enemy],
        bots: &[BotInfo],
        clock: f32,
    ) {
        self.team = team;
        self.members = members;

        let count = self.members.len() as f32;

        self.centroid = (!self.members.is_empty()).then(|| {
            let sum = self
                .members
                .iter()
                .fold([0.0, 0.0], |acc, m| [acc[0] + m.pos[0], acc[1] + m.pos[1]]);

            [sum[0] / count, sum[1] / count]
        });

        self.sightings.clear();

        for id in bots.iter().flat_map(|bot| bot.sees.iter().copied()) {
            match self.sightings.iter_mut().find(|(seen, _)| *seen == id) {
                Some((_, n)) => *n = n.saturating_add(1),
                None => self.sightings.push((id, 1)),
            }
        }

        self.sightings.sort_by_key(|(id, _)| *id);
        self.update_focus(enemies, clock);
        self.update_roles(bots, clock);
    }

    fn focus_score_of(&self, enemy: &Enemy) -> f32 {
        let near: f32 = self
            .members
            .iter()
            .map(|m| 1.0 / (1.0 + dist(m.pos, enemy.pos) / 300.0))
            .sum();
        let seen = self
            .sightings
            .iter()
            .find(|(id, _)| *id == enemy.id)
            .map_or(0, |(_, n)| *n);

        near + 0.5 * f32::from(seen) + 0.3 * f32::from(3u8.saturating_sub(enemy.condition))
    }

    /// Фокус: лучший по очкам враг (при равенстве — меньший id) с
    /// гистерезисом.
    fn update_focus(&mut self, enemies: &[Enemy], clock: f32) {
        let mut best: Option<(u32, f32)> = None;

        for enemy in enemies {
            let score = self.focus_score_of(enemy);

            if best.is_none_or(|(_, best_score)| score > best_score) {
                best = Some((enemy.id, score));
            }
        }

        let Some((best_id, best_score)) = best else {
            self.focus = None;
            self.focus_score = 0.0;
            return;
        };

        let current = self
            .focus
            .and_then(|focus| enemies.iter().find(|enemy| enemy.id == focus))
            .map(|enemy| (enemy.id, self.focus_score_of(enemy)));

        if let Some((id, score)) = current {
            let keep = id == best_id
                || clock - self.focus_since < FOCUS_HOLD
                || best_score < FOCUS_SWITCH_RATIO * score;

            if keep {
                self.focus_score = score;
                return;
            }
        }

        self.focus = Some(best_id);
        self.focus_score = best_score;
        self.focus_since = clock;
    }

    /// Роли раз в `ROLES_INTERVAL`: раненый — `Support`; при трёх ботах и
    /// больше самый агрессивный из остальных — `Flanker`; прочие — `Assault`.
    fn update_roles(&mut self, bots: &[BotInfo], clock: f32) {
        if self.roles_at.is_some_and(|at| clock - at < ROLES_INTERVAL) {
            return;
        }

        self.roles_at = Some(clock);
        self.roles = bots
            .iter()
            .map(|bot| {
                let role = if bot.health < SUPPORT_HEALTH {
                    Role::Support
                } else {
                    Role::Assault
                };

                (bot.id, role)
            })
            .collect();

        if bots.len() < 3 {
            return;
        }

        // при равенстве остаётся меньший id: боты идут по возрастанию
        let mut flanker: Option<(u32, f32)> = None;

        for bot in bots.iter().filter(|bot| bot.health >= SUPPORT_HEALTH) {
            if flanker.is_none_or(|(_, aggression)| bot.aggression > aggression) {
                flanker = Some((bot.id, bot.aggression));
            }
        }

        if let Some((id, _)) = flanker
            && let Some(entry) = self.roles.iter_mut().find(|(bot, _)| *bot == id)
        {
            entry.1 = Role::Flanker;
        }
    }

    /// Роль бота (по умолчанию `Assault`).
    pub fn role(&self, id: u32) -> Role {
        self.roles
            .iter()
            .find(|(bot, _)| *bot == id)
            .map_or(Role::Assault, |(_, role)| *role)
    }

    /// Члены команды ближе `radius` к `pos`, кроме `exclude`.
    pub fn allies_near(
        &self,
        pos: [f32; 2],
        radius: f32,
        exclude: u32,
    ) -> impl Iterator<Item = &Member> {
        self.members
            .iter()
            .filter(move |m| m.id != exclude && dist(m.pos, pos) < radius)
    }

    /// Суммарная «сила» членов команды ближе `radius` к `pos`.
    pub fn strength_near(&self, pos: [f32; 2], radius: f32) -> f32 {
        self.members
            .iter()
            .filter(|m| dist(m.pos, pos) < radius)
            .map(|m| m.strength)
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: u32, x: f32, y: f32) -> Member {
        Member {
            id,
            pos: [x, y],
            level: 0,
            strength: 1.0,
            is_bot: true,
            mode: Some(BotMode::Hunt),
            target: None,
        }
    }

    fn bot(id: u32, health: f32, aggression: f32, sees: &[u32]) -> BotInfo {
        BotInfo {
            id,
            health,
            aggression,
            sees: sees.to_vec(),
        }
    }

    fn enemy(id: u32, x: f32, y: f32, condition: u8) -> Enemy {
        Enemy {
            id,
            pos: [x, y],
            condition,
        }
    }

    #[test]
    fn team_board_focus_and_hysteresis() {
        let mut board = TeamBoard::default();
        let members = vec![member(1, 0.0, 0.0), member(2, 0.0, 100.0)];
        let bots = [bot(1, 100.0, 0.5, &[10]), bot(2, 100.0, 0.5, &[])];
        let enemies = [enemy(10, 300.0, 0.0, 3), enemy(11, 600.0, 0.0, 3)];

        board.update(1, members.clone(), &enemies, &bots, 0.0);

        // ближе и виден — фокус на 10
        assert_eq!(board.focus, Some(10));
        assert_eq!(board.sightings, vec![(10, 1)]);
        assert_eq!(board.centroid, Some([0.0, 50.0]));

        // 11 стал лучше (рядом, подбит, виден), но меньше чем в 1.3 раза
        let bots = [bot(1, 100.0, 0.5, &[10]), bot(2, 100.0, 0.5, &[11])];
        let closer = [enemy(10, 300.0, 0.0, 3), enemy(11, 300.0, 0.0, 2)];

        board.update(1, members.clone(), &closer, &bots, 5.0);
        assert_eq!(board.focus, Some(10));

        // 11 намного лучше: видят оба, корпус почти разбит — смена после выдержки
        let bots = [bot(1, 100.0, 0.5, &[11]), bot(2, 100.0, 0.5, &[11])];
        let far10 = [enemy(10, 900.0, 0.0, 3), enemy(11, 200.0, 50.0, 1)];

        board.update(1, members.clone(), &far10, &bots, 5.5);
        assert_eq!(board.focus, Some(11));

        // только что сменился: держится 3 с даже при лучшем кандидате
        let bots = [bot(1, 100.0, 0.5, &[10]), bot(2, 100.0, 0.5, &[10])];
        let back = [enemy(10, 100.0, 50.0, 1), enemy(11, 900.0, 0.0, 3)];

        board.update(1, members.clone(), &back, &bots, 6.0);
        assert_eq!(board.focus, Some(11));

        // фокус погиб — сразу лучший
        board.update(1, members, &back[..1], &bots, 6.1);
        assert_eq!(board.focus, Some(10));
    }

    #[test]
    fn roles_assign_one_flanker() {
        let mut board = TeamBoard::default();
        let members = vec![
            member(1, 0.0, 0.0),
            member(2, 0.0, 50.0),
            member(3, 0.0, 100.0),
            member(4, 0.0, 150.0),
        ];
        let bots = [
            bot(1, 100.0, 0.3, &[]),
            bot(2, 100.0, 0.9, &[]),
            bot(3, 40.0, 1.0, &[]),
            bot(4, 100.0, 0.6, &[]),
        ];

        board.update(1, members.clone(), &[], &bots, 0.0);

        assert_eq!(board.role(1), Role::Assault);
        assert_eq!(board.role(2), Role::Flanker);
        assert_eq!(board.role(3), Role::Support);
        assert_eq!(board.role(4), Role::Assault);
        assert_eq!(board.role(99), Role::Assault);

        // роли держатся 2 с
        let bots = [
            bot(1, 100.0, 0.95, &[]),
            bot(2, 100.0, 0.9, &[]),
            bot(3, 40.0, 1.0, &[]),
            bot(4, 100.0, 0.6, &[]),
        ];

        board.update(1, members.clone(), &[], &bots, 1.0);
        assert_eq!(board.role(2), Role::Flanker);

        board.update(1, members, &[], &bots, 2.0);
        assert_eq!(board.role(1), Role::Flanker);
        assert_eq!(board.role(2), Role::Assault);

        // меньше трёх ботов — без фланга
        let mut pair = TeamBoard::default();

        pair.update(
            1,
            vec![member(1, 0.0, 0.0), member(2, 0.0, 50.0)],
            &[],
            &[bot(1, 100.0, 0.3, &[]), bot(2, 100.0, 0.9, &[])],
            0.0,
        );
        assert_eq!(pair.role(2), Role::Assault);
    }

    #[test]
    fn strength_near_counts_members() {
        let mut board = TeamBoard::default();
        let mut human = member(2, 100.0, 0.0);

        human.is_bot = false;
        human.mode = None;
        human.strength = 0.6;
        board.update(1, vec![member(1, 0.0, 0.0), human], &[], &[], 0.0);

        assert!((board.strength_near([0.0, 0.0], 350.0) - 1.6).abs() < 1e-6);
        assert_eq!(board.allies_near([0.0, 0.0], 350.0, 1).count(), 1);
    }
}
