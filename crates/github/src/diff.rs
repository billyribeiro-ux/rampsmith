//! Changed-line counts, the size measure behind the pull-request cap (PLAN §15).
//!
//! A count is insertions plus deletions of the shortest line edit script between two texts,
//! which is what GitHub shows as additions and deletions. Lines keep their terminator, so a
//! file that gains or loses its final newline counts its last line as changed, as Git does.

/// Above this many edits the exact count is not needed: the change is far over any cap, and
/// the count saturates at an upper bound instead of spending quadratic time.
const MAX_EXACT_EDITS: usize = 4096;

/// Insertions plus deletions turning `before` into `after`, by line. Exact up to 4,096 edits;
/// above that it returns an upper bound that is still above 4,096.
#[must_use]
pub fn changed_lines(before: &str, after: &str) -> u32 {
    let a: Vec<&str> = before.split_inclusive('\n').collect();
    let b: Vec<&str> = after.split_inclusive('\n').collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let a = a.get(prefix..).unwrap_or_default();
    let b = b.get(prefix..).unwrap_or_default();
    let suffix = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let a = a.get(..a.len() - suffix).unwrap_or_default();
    let b = b.get(..b.len() - suffix).unwrap_or_default();
    let edits = edit_distance(a, b, MAX_EXACT_EDITS).unwrap_or(a.len() + b.len());
    u32::try_from(edits).unwrap_or(u32::MAX)
}

/// The length of the shortest insert/delete script from `a` to `b` (Myers 1986, greedy
/// forward search), or `None` when it exceeds `max`.
fn edit_distance(old: &[&str], new: &[&str], max: usize) -> Option<usize> {
    let (old_len, new_len) = (old.len(), new.len());
    let max = max.min(old_len + new_len);
    // Diagonal = old position - new position, from -max to max; `furthest[diagonal + offset]`
    // holds the furthest old position reached on that diagonal.
    let offset = isize::try_from(max + 1).ok()?;
    let mut furthest = vec![0_usize; 2 * max + 3];
    for edits in 0..=max {
        let bound = isize::try_from(edits).ok()?;
        let mut diagonal = -bound;
        while diagonal <= bound {
            let slot = usize::try_from(diagonal + offset).ok()?;
            let from_above = furthest.get(slot + 1).copied()?;
            let from_left = furthest.get(slot - 1).copied()?;
            let mut pos_old = if diagonal == -bound || (diagonal != bound && from_left < from_above)
            {
                from_above
            } else {
                from_left + 1
            };
            let mut pos_new = usize::try_from(isize::try_from(pos_old).ok()? - diagonal).ok()?;
            while pos_old < old_len && pos_new < new_len && old.get(pos_old) == new.get(pos_new) {
                pos_old += 1;
                pos_new += 1;
            }
            *furthest.get_mut(slot)? = pos_old;
            if pos_old >= old_len && pos_new >= new_len {
                return Some(edits);
            }
            diagonal += 2;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_texts_have_no_changes() {
        assert_eq!(changed_lines("", ""), 0);
        assert_eq!(changed_lines("a\nb\n", "a\nb\n"), 0);
    }

    #[test]
    fn one_line_edited_counts_one_deletion_and_one_insertion() {
        assert_eq!(changed_lines("a\nb\nc\n", "a\nB\nc\n"), 2);
    }

    #[test]
    fn insertions_and_deletions_count_separately() {
        assert_eq!(changed_lines("a\nc\n", "a\nb\nc\n"), 1);
        assert_eq!(changed_lines("a\nb\nc\n", "a\nc\n"), 1);
        assert_eq!(changed_lines("", "a\nb\n"), 2);
        assert_eq!(changed_lines("a\nb\n", ""), 2);
    }

    #[test]
    fn separated_edits_do_not_count_the_lines_between_them() {
        let before = "1\n2\n3\n4\n5\n6\n7\n8\n";
        let after = "1\nX\n3\n4\n5\n6\nY\n8\n";
        assert_eq!(changed_lines(before, after), 4);
    }

    #[test]
    fn a_lost_final_newline_changes_the_last_line() {
        assert_eq!(changed_lines("a\nb\n", "a\nb"), 2);
    }

    #[test]
    fn a_crlf_change_counts_every_line() {
        assert_eq!(changed_lines("a\nb\n", "a\r\nb\r\n"), 4);
    }

    #[test]
    fn huge_rewrites_saturate_above_the_exact_limit() {
        let numbered = |tag: &str| -> String {
            (0..5000)
                .map(|i| tag.to_owned() + &i.to_string() + "\n")
                .collect()
        };
        let (before, after) = (numbered("a"), numbered("b"));
        let count = changed_lines(&before, &after);
        assert_eq!(count, 10_000);
    }

    #[test]
    fn edit_distance_matches_a_known_example() {
        // Myers' paper example: ABCABBA -> CBABAC has D = 5.
        let a: Vec<&str> = "ABCABBA".split("").filter(|s| !s.is_empty()).collect();
        let b: Vec<&str> = "CBABAC".split("").filter(|s| !s.is_empty()).collect();
        assert_eq!(edit_distance(&a, &b, 100), Some(5));
        assert_eq!(edit_distance(&a, &b, 4), None);
    }
}
