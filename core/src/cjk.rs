//! 汉字二元组（bigram）切分与查询判定。
//!
//! 为什么需要这一层：SQLite 自带的两种分词器都覆盖不了“中文二字词”：
//! * `trigram` 要求查询串至少 3 个字符，否则直接查不到任何行；
//! * `unicode61` 会把整段中文（如“知识蒸馏模型”）当成一个 token，
//!   二字词（“蒸馏/量化/微调”）和短缩写（“RL”）都无法命中。
//!
//! 因此检索层额外维护一份“相邻汉字二元组”的 FTS5 索引，见
//! [`crate::search::initialize`]。本模块只做纯切分，便于单元测试；
//! 其中的码位范围必须与 `search.rs` 里 SQL 触发器的 `char(...)` 边界一致，
//! 否则建索引时写入的二元组和查询时算出的二元组会对不上。

/// 汉字（含扩展 A 与兼容区），与 `search.rs` 中 `HAN_RANGES` 完全一致。
pub fn is_han(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

/// 整串是否都是汉字。
pub fn all_han(text: &str) -> bool {
    !text.is_empty() && text.chars().all(is_han)
}

/// 切出“相邻两个汉字”组成的二元组：去重并保持首次出现顺序。
///
/// 非汉字字符（标点、空格、拉丁字母、数字）会打断相邻关系，
/// 与 SQL 触发器 `substr(text,i,2)` + 两端汉字判定的行为一致。
pub fn han_bigrams(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut previous: Option<char> = None;
    for ch in text.chars() {
        match previous {
            Some(prev) if is_han(ch) => {
                let pair: String = [prev, ch].iter().collect();
                if !out.contains(&pair) {
                    out.push(pair);
                }
                previous = Some(ch);
            }
            _ => {
                previous = if is_han(ch) { Some(ch) } else { None };
            }
        }
    }
    out
}

/// 查询串本身恰好是一个汉字二元组时返回它，供 FTS5 `MATCH` 使用。
///
/// 只有 2 个汉字才需要走二元组索引；1 个汉字噪声太大，3 个及以上
/// 字符由 trigram 索引负责。
pub fn han_query(query: &str) -> Option<&str> {
    let mut chars = query.chars();
    let first = chars.next()?;
    let second = chars.next()?;
    if chars.next().is_some() || !is_han(first) || !is_han(second) {
        return None;
    }
    Some(query)
}

/// 把查询串转成安全的 FTS5 短语（内部双引号按 FTS5 规则转义）。
pub fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn han_bigrams_break_on_punctuation_and_latin() {
        assert_eq!(han_bigrams("知识蒸馏模型"), vec!["知识", "识蒸", "蒸馏", "馏模", "模型"]);
        assert_eq!(han_bigrams("蒸馏 distillation"), vec!["蒸馏"]);
        assert_eq!(han_bigrams("(a) 参考文献"), vec!["参考", "考文", "文献"]);
        assert_eq!(han_bigrams("单"), Vec::<String>::new());
        assert_eq!(han_bigrams("plain english only"), Vec::<String>::new());
        // 去重但保留首次出现顺序
        assert_eq!(han_bigrams("蒸馏蒸馏量化"), vec!["蒸馏", "馏蒸", "馏量", "量化"]);
    }

    #[test]
    fn only_two_han_characters_use_the_bigram_index() {
        assert_eq!(han_query("蒸馏"), Some("蒸馏"));
        assert_eq!(han_query("单"), None);
        assert_eq!(han_query("蒸馏模"), None);
        assert_eq!(han_query("RL"), None);
        assert_eq!(han_query(" 蒸馏"), None);
        assert_eq!(fts_phrase("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn range_matches_sql_char_boundaries() {
        // 这三个码位分别落在扩展 A / 基本区 / 兼容区，触发器里都算了汉字。
        assert!(is_han('\u{3400}'));
        assert!(is_han('一'));
        assert!(is_han('\u{9FFF}'));
        assert!(is_han('\u{F900}'));
        assert!(!is_han('，'));
        assert!(!is_han('Ａ'));
    }
}
