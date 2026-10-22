//! The plain-language catalog for Rampsmith's own rules (`rs-*`), mirrored from
//! `packages/a11y-rules/src/rules.ts` (PLAN §13). The unit test pins the id list; the
//! TypeScript catalog stays the source of criteria and impact, which findings store.

/// One sentence naming the problem, and a paragraph explaining it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RuleText {
    /// One plain-language sentence naming the problem.
    pub title: &'static str,
    /// The explanation shown on a finding's page.
    pub explanation: &'static str,
}

/// The `rs-*` rules in catalog order: id, title, explanation.
const RS: [(&str, &str, &str); 19] = [
    (
        "rs-media-alt-empty",
        "A product image has no alt text, so screen-reader users miss what it shows.",
        "A product image has no alt text, so screen-reader users miss what it shows. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-media-alt-filename",
        "A product image uses a file name as its alt text instead of describing the image.",
        "A product image uses a file name as its alt text instead of describing the image. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-heading-skip",
        "A heading skips a level, which breaks the outline screen-reader users navigate by.",
        "A heading skips a level, which breaks the outline screen-reader users navigate by. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-link-empty",
        "A link has no text or accessible name, so its purpose cannot be announced.",
        "A link has no text or accessible name, so its purpose cannot be announced. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-link-vague",
        "A link says something like \"click here\" and does not say where it goes.",
        "A link says something like \"click here\" and does not say where it goes. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-img-alt-missing",
        "An image in the text has no alt attribute.",
        "An image in the text has no alt attribute. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-img-alt-filename",
        "An image in the text uses a file name as its alt text.",
        "An image in the text uses a file name as its alt text. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-table-no-headers",
        "A data table has no header cells, so its rows and columns cannot be told apart by ear.",
        "A data table has no header cells, so its rows and columns cannot be told apart by ear. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-rich-text-color-only",
        "Some text is set apart from the words around it by colour alone.",
        "Some text is set apart from the words around it by colour alone. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-menu-item-label-empty",
        "A menu item has no label, so its link has no accessible name.",
        "A menu item has no label, so its link has no accessible name. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-menu-item-label-duplicate",
        "Two items in the same menu level share a label, so they cannot be told apart.",
        "Two items in the same menu level share a label, so they cannot be told apart. Rampsmith found this in your store's content, so it can be changed in the Shopify admin; where a fix is offered you review it before anything changes.",
    ),
    (
        "rs-keyboard-trap",
        "Keyboard focus gets stuck in part of the page and cannot move on with Tab or Escape.",
        "Keyboard focus gets stuck in part of the page and cannot move on with Tab or Escape. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-focus-indicator-missing",
        "An element shows no visible change when it receives keyboard focus.",
        "An element shows no visible change when it receives keyboard focus. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-focus-stop-hidden",
        "Keyboard focus lands on an element that is off screen or invisible.",
        "Keyboard focus lands on an element that is off screen or invisible. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-focus-obscured",
        "A focused element is completely hidden behind a sticky header, banner or drawer.",
        "A focused element is completely hidden behind a sticky header, banner or drawer. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-reflow-horizontal-scroll",
        "At 320 CSS pixels wide the page needs horizontal scrolling to read.",
        "At 320 CSS pixels wide the page needs horizontal scrolling to read. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-text-spacing-clipped",
        "Text is cut off when a reader increases line, letter, word or paragraph spacing.",
        "Text is cut off when a reader increases line, letter, word or paragraph spacing. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-text-spacing-overlap",
        "Text spills over other content when a reader increases text spacing.",
        "Text spills over other content when a reader increases text spacing. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
    (
        "rs-media-autoplay-audio",
        "Audio plays automatically for more than 3 seconds with no way to pause or mute it.",
        "Audio plays automatically for more than 3 seconds with no way to pause or mute it. Rampsmith saw this on the rendered page, so the change belongs in the theme's code; Rampsmith does not change theme files itself.",
    ),
];

/// The ids of the `rs-*` rules the catalog describes.
#[cfg(test)]
pub(crate) fn rs_ids() -> impl Iterator<Item = &'static str> {
    RS.iter().map(|(id, _, _)| *id)
}

/// The text for a rule: the catalog entry for an `rs-*` rule, else a generic sentence for an
/// axe-core rule, whose own help travels with the finding's occurrences.
#[must_use]
pub(crate) fn text(rule_id: &str) -> RuleText {
    RS.iter()
        .find(|(id, _, _)| *id == rule_id)
        .map_or(
            RuleText {
                title: "An element on the page fails an accessibility check.",
                explanation: "An automated check found an element that fails a WCAG 2.2 success criterion. The occurrences below show where on the page it was found.",
            },
            |&(_, title, explanation)| RuleText { title, explanation },
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every custom rule in the TypeScript catalog has text here, and nothing extra.
    #[test]
    fn every_rs_rule_in_the_catalog_has_text() {
        let source = include_str!("../../../packages/a11y-rules/src/rules.ts");
        let mut declared: Vec<&str> = source
            .lines()
            .filter_map(|line| line.trim().strip_prefix("'rs-"))
            .filter_map(|rest| rest.strip_suffix("': rule("))
            .collect();
        declared.sort_unstable();
        let mut known: Vec<&str> = rs_ids().filter_map(|id| id.strip_prefix("rs-")).collect();
        known.sort_unstable();
        assert_eq!(declared, known);
        assert!(!declared.is_empty());
    }

    #[test]
    fn an_axe_rule_gets_the_generic_text() {
        assert!(text("image-alt").title.contains("accessibility check"));
        assert!(text("rs-media-alt-empty").title.contains("no alt text"));
    }
}
