//! «Характер» бота: пресет сложности (`coreParams.bots`) + разброс.

use serde::{Deserialize, Serialize};
use vimp_engine_core::rng::Rng;

use crate::config::{BotRules, BotSkill, BotSkillParams};

/// «Характер» конкретного бота: пресет сложности + индивидуальный разброс.
/// Разыгрывается один раз при создании бота и едет в дамп.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    pub skill: BotSkill,
    pub reaction_time: f32,
    pub aim_error: f32,
    pub aim_settle_time: f32,
    pub aim_tremor: f32,
    pub fire_tolerance: f32,
    pub burst_shots: [u8; 2],
    pub burst_pause: [f32; 2],
    pub shot_interval: f32,
    pub radar_interval: f32,
    pub radar_noise: f32,
    pub preferred_range: [f32; 2],
    pub aggression: f32,
    pub retreat_health: f32,
    pub retreat_advantage: f32,
    pub steer_noise: f32,
    pub edge_risk: f32,
    pub hesitation: f32,
    pub panic_fire: f32,
}

/// Пресет `normal` без разброса: так читается старый дамп без профиля.
impl Default for BotProfile {
    fn default() -> Self {
        let rules = BotRules::default();

        Self::exact(BotSkill::Normal, &rules.presets.normal)
    }
}

impl BotProfile {
    /// Профиль ровно по пресету, без разброса.
    fn exact(skill: BotSkill, p: &BotSkillParams) -> Self {
        Self {
            skill,
            reaction_time: p.reaction_time,
            aim_error: p.aim_error,
            aim_settle_time: p.aim_settle_time,
            aim_tremor: p.aim_tremor,
            fire_tolerance: p.fire_tolerance,
            burst_shots: p.burst_shots,
            burst_pause: p.burst_pause,
            shot_interval: p.shot_interval,
            radar_interval: p.radar_interval,
            radar_noise: p.radar_noise,
            preferred_range: p.preferred_range,
            aggression: p.aggression,
            retreat_health: p.retreat_health,
            retreat_advantage: p.retreat_advantage,
            steer_noise: p.steer_noise,
            edge_risk: p.edge_risk,
            hesitation: p.hesitation,
            panic_fire: p.panic_fire,
        }
    }

    /// Разыгрывает профиль. Порядок полей фиксирован (как в таблице
    /// пресета), и `rng` дёргается строго по нему — иначе рушится
    /// детерминизм.
    pub fn roll(rules: &BotRules, rng: &mut Rng) -> Self {
        let v = rules.variance;
        let p = rules.params();
        // множитель скаляра: 1 ± variance/2
        let factor = |rng: &mut Rng| 1.0 + v * rng.range(-0.5, 0.5);

        let reaction_time = p.reaction_time * factor(rng);
        let aim_error = p.aim_error * factor(rng);
        let aim_settle_time = p.aim_settle_time * factor(rng);
        let aim_tremor = p.aim_tremor * factor(rng);
        let fire_tolerance = p.fire_tolerance * factor(rng);
        // число выстрелов в очереди не варьируется
        let burst_shots = p.burst_shots;
        let pause = factor(rng);
        let burst_pause = [p.burst_pause[0] * pause, p.burst_pause[1] * pause];
        let shot_interval = p.shot_interval * factor(rng);
        let radar_interval = p.radar_interval * factor(rng);
        let radar_noise = p.radar_noise * factor(rng);
        let range = factor(rng);
        let preferred_range = [p.preferred_range[0] * range, p.preferred_range[1] * range];
        let aggression = (p.aggression + v * rng.range(-0.3, 0.3)).clamp(0.0, 1.0);
        let retreat_health = (p.retreat_health * factor(rng)).clamp(5.0, 90.0);
        let retreat_advantage = p.retreat_advantage * factor(rng);
        let steer_noise = p.steer_noise * factor(rng);
        let edge_risk = (p.edge_risk * factor(rng)).clamp(0.0, 1.0);
        let hesitation = (p.hesitation * factor(rng)).clamp(0.0, 1.0);
        let panic_fire = (p.panic_fire * factor(rng)).clamp(0.0, 1.0);

        Self {
            skill: rules.skill,
            reaction_time,
            aim_error,
            aim_settle_time,
            aim_tremor,
            fire_tolerance,
            burst_shots,
            burst_pause,
            shot_interval,
            radar_interval,
            radar_noise,
            preferred_range,
            aggression,
            retreat_health,
            retreat_advantage,
            steer_noise,
            edge_risk,
            hesitation,
            panic_fire,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(skill: BotSkill, variance: f32) -> BotRules {
        BotRules {
            skill,
            variance,
            ..BotRules::default()
        }
    }

    #[test]
    fn zero_variance_rolls_the_preset() {
        for skill in [BotSkill::Easy, BotSkill::Normal, BotSkill::Hard] {
            let rules = rules(skill, 0.0);
            let profile = BotProfile::roll(&rules, &mut Rng::new(11));

            assert_eq!(profile, BotProfile::exact(skill, rules.params()));
        }
    }

    #[test]
    fn same_seed_rolls_the_same_profile() {
        let rules = rules(BotSkill::Normal, 0.8);

        assert_eq!(
            BotProfile::roll(&rules, &mut Rng::new(5)),
            BotProfile::roll(&rules, &mut Rng::new(5))
        );
        assert_ne!(
            BotProfile::roll(&rules, &mut Rng::new(5)),
            BotProfile::roll(&rules, &mut Rng::new(6))
        );
    }

    #[test]
    fn full_variance_stays_in_bounds() {
        let mut rng = Rng::new(42);

        for skill in [BotSkill::Easy, BotSkill::Normal, BotSkill::Hard] {
            let rules = rules(skill, 1.0);
            let p = *rules.params();

            for _ in 0..200 {
                let r = BotProfile::roll(&rules, &mut rng);
                let within = |value: f32, base: f32| {
                    value >= base * 0.5 - 1e-6 && value <= base * 1.5 + 1e-6
                };

                assert!(within(r.reaction_time, p.reaction_time) && r.reaction_time > 0.0);
                assert!(within(r.aim_error, p.aim_error));
                assert!(within(r.aim_settle_time, p.aim_settle_time) && r.aim_settle_time > 0.0);
                assert!(within(r.aim_tremor, p.aim_tremor));
                assert!(within(r.fire_tolerance, p.fire_tolerance) && r.fire_tolerance > 0.0);
                assert_eq!(r.burst_shots, p.burst_shots);
                assert!(r.burst_pause[0] >= 0.0 && r.burst_pause[0] <= r.burst_pause[1]);
                assert!(within(r.shot_interval, p.shot_interval) && r.shot_interval > 0.0);
                assert!(within(r.radar_interval, p.radar_interval) && r.radar_interval > 0.0);
                assert!(within(r.radar_noise, p.radar_noise));
                assert!(
                    r.preferred_range[0] >= 0.0 && r.preferred_range[0] <= r.preferred_range[1]
                );
                assert!((0.0..=1.0).contains(&r.aggression));
                assert!((5.0..=90.0).contains(&r.retreat_health));
                assert!(
                    within(r.retreat_advantage, p.retreat_advantage) && r.retreat_advantage > 0.0
                );
                assert!(within(r.steer_noise, p.steer_noise));
                assert!((0.0..=1.0).contains(&r.edge_risk));
                assert!((0.0..=1.0).contains(&r.hesitation));
                assert!((0.0..=1.0).contains(&r.panic_fire));
            }
        }
    }
}
