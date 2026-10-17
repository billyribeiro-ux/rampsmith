//! Text that goes into commits and GitHub Markdown. Finding summaries can carry text taken from
//! a storefront, which an attacker may control, so nothing reaches a pull request body or a
//! commit message without passing through one of these functions.

/// Collapses every run of whitespace and control characters into one space and trims, so the
/// text fits on one line and cannot start a new commit trailer, heading or list item.
#[must_use]
pub(crate) fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if c.is_whitespace() || c.is_control() || is_invisible(c) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

/// Bidirectional overrides and zero-width characters, which can make a line read differently
/// from what it contains.
const fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}'
    )
}

/// Truncates to at most `max` characters on a character boundary, marking a cut with `…`.
#[must_use]
pub(crate) fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Untrusted text as a Markdown code span. Inside a code span GitHub renders no HTML, links,
/// images, `@` mentions or `#` references. The fence is one backtick longer than the longest
/// backtick run in the text, so the text cannot close it early.
#[must_use]
pub(crate) fn code_span(text: &str) -> String {
    let text = one_line(text);
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(longest + 1);
    // CommonMark strips one leading and trailing space when both are present, so padding
    // keeps a text that starts or ends with a backtick intact.
    if text.starts_with('`') || text.ends_with('`') || text.is_empty() {
        format!("{fence} {text} {fence}")
    } else {
        format!("{fence}{text}{fence}")
    }
}

/// Trusted prose (Rampsmith's own recipe summaries) as literal Markdown text: every ASCII
/// punctuation character is backslash-escaped, which the `CommonMark` spec renders literally,
/// and `@` and `#` get a word joiner after them so they never become mentions or references.
#[must_use]
pub(crate) fn escape_text(text: &str) -> String {
    let text = one_line(text);
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        match c {
            '@' | '#' => {
                out.push('\\');
                out.push(c);
                out.push('\u{2060}');
            }
            c if c.is_ascii_punctuation() => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_collapses_newlines_and_controls() {
        assert_eq!(one_line("  a\n\nb\r\n\tc\u{0} "), "a b c");
        assert_eq!(one_line("x\nRampsmith-Fix: evil"), "x Rampsmith-Fix: evil");
        assert_eq!(one_line("a\u{202E}b\u{200B}c"), "a b c");
        assert_eq!(one_line(""), "");
    }

    #[test]
    fn truncate_cuts_on_character_boundaries() {
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(truncate("abcd", 3), "ab…");
        assert_eq!(truncate("ééé", 2), "é…");
    }

    #[test]
    fn code_span_neutralises_markdown_and_html() {
        assert_eq!(
            code_span("<img src=x onerror=alert(1)>"),
            "`<img src=x onerror=alert(1)>`"
        );
        assert_eq!(code_span("@octocat #1"), "`@octocat #1`");
        assert_eq!(code_span("a`b"), "``a`b``");
        assert_eq!(code_span("`x`"), "`` `x` ``");
        assert_eq!(code_span("a ``` b"), "````a ``` b````");
        assert_eq!(code_span("line\n# Heading"), "`line # Heading`");
        assert_eq!(code_span(""), "`  `");
    }

    #[test]
    fn escape_text_makes_punctuation_literal() {
        assert_eq!(escape_text("add label [x](y)"), "add label \\[x\\]\\(y\\)");
        assert_eq!(escape_text("*bold* <b>"), "\\*bold\\* \\<b\\>");
        assert_eq!(
            escape_text("ping @team #12"),
            "ping \\@\u{2060}team \\#\u{2060}12"
        );
        assert_eq!(escape_text("a\n## b"), "a \\#\u{2060}\\#\u{2060} b");
    }
}
