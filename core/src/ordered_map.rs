//! `IndexMap` в дампе состояния — последовательностью пар `[ключ, значение]`
//! (`#[serde(with = "crate::ordered_map")]`). Дамп идёт через JSON, а ключи
//! JSON-объекта сортируются как строки (`1, 10, 2, …`): после восстановления
//! порядок карты был бы другим, а от него зависит симуляция (танки
//! обновляются и стреляют по порядку карты). Старый дамп с объектом тоже
//! читается — тогда порядок как в объекте.

use std::borrow::Borrow;
use std::fmt;
use std::hash::Hash;
use std::marker::PhantomData;

use indexmap::IndexMap;
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// `map` — сама карта или ссылка на неё (поля дампа-заимствования).
pub(crate) fn serialize<M, K, V, S>(map: &M, serializer: S) -> Result<S::Ok, S::Error>
where
    M: Borrow<IndexMap<K, V>>,
    K: Serialize + Hash + Eq,
    V: Serialize,
    S: Serializer,
{
    indexmap::map::serde_seq::serialize(map.borrow(), serializer)
}

pub(crate) fn deserialize<'de, K, V, D>(deserializer: D) -> Result<IndexMap<K, V>, D::Error>
where
    K: Deserialize<'de> + Hash + Eq,
    V: Deserialize<'de>,
    D: Deserializer<'de>,
{
    deserializer.deserialize_any(OrderedMapVisitor(PhantomData))
}

struct OrderedMapVisitor<K, V>(PhantomData<(K, V)>);

impl<'de, K, V> Visitor<'de> for OrderedMapVisitor<K, V>
where
    K: Deserialize<'de> + Hash + Eq,
    V: Deserialize<'de>,
{
    type Value = IndexMap<K, V>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a sequence of [key, value] pairs or a map")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut map = IndexMap::with_capacity(seq.size_hint().unwrap_or(0));

        while let Some((key, value)) = seq.next_element::<(K, V)>()? {
            map.insert(key, value);
        }

        Ok(map)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
        let mut map = IndexMap::with_capacity(access.size_hint().unwrap_or(0));

        while let Some((key, value)) = access.next_entry::<K, V>()? {
            map.insert(key, value);
        }

        Ok(map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize)]
    struct Dump {
        #[serde(with = "crate::ordered_map")]
        map: IndexMap<u32, u8>,
    }

    #[test]
    fn order_survives_json() {
        let map: IndexMap<u32, u8> = [(10, 1), (2, 2), (1, 3)].into_iter().collect();
        let value = serde_json::to_value(Dump { map: map.clone() }).unwrap();
        let back: Dump = serde_json::from_value(value).unwrap();

        assert_eq!(back.map.keys().collect::<Vec<_>>(), [&10, &2, &1]);
        assert_eq!(back.map, map);
    }

    #[test]
    fn old_object_form_still_loads() {
        let back: Dump = serde_json::from_value(serde_json::json!({
            "map": { "2": 5, "10": 6 }
        }))
        .unwrap();

        assert_eq!(back.map[&2], 5);
        assert_eq!(back.map[&10], 6);
    }
}
