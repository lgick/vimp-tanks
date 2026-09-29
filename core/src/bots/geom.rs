//! Чистая математика ИИ: расстояния, углы, повороты.

use rapier2d::prelude::*;

pub(crate) fn dist_sq(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];

    dx * dx + dy * dy
}

pub(crate) fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    dist_sq(a, b).sqrt()
}

pub(crate) fn rotate(v: Vector, angle: f32) -> Vector {
    Rotation::from_angle(angle).transform_vector(v)
}

/// Угол в диапазон (−π, π].
pub(crate) fn normalize_angle(angle: f32) -> f32 {
    angle.sin().atan2(angle.cos())
}

/// Направление вектора, рад (`atan2(y, x)`).
pub(crate) fn angle_of(v: [f32; 2]) -> f32 {
    v[1].atan2(v[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::f32::consts::{FRAC_PI_2, PI};

    const EPS: f32 = 1e-5;

    #[test]
    fn normalize_angle_wraps_into_the_half_open_range() {
        assert!((normalize_angle(PI).abs() - PI).abs() < EPS);
        assert!((normalize_angle(-PI).abs() - PI).abs() < EPS);
        assert!((normalize_angle(3.0 * PI).abs() - PI).abs() < EPS);
        assert!((normalize_angle(2.0 * PI + 0.5) - 0.5).abs() < EPS);
        assert!((normalize_angle(-2.0 * PI - 0.5) + 0.5).abs() < EPS);
    }

    #[test]
    fn angle_of_follows_the_axes() {
        assert!(angle_of([1.0, 0.0]).abs() < EPS);
        assert!((angle_of([0.0, 1.0]) - FRAC_PI_2).abs() < EPS);
        assert!((angle_of([-1.0, 0.0]) - PI).abs() < EPS);
        assert!((angle_of([0.0, -1.0]) + FRAC_PI_2).abs() < EPS);
    }

    #[test]
    fn dist_is_the_root_of_dist_sq() {
        assert!((dist([0.0, 0.0], [3.0, 4.0]) - 5.0).abs() < EPS);
        assert_eq!(dist_sq([1.0, 1.0], [4.0, 5.0]), 25.0);
    }
}
