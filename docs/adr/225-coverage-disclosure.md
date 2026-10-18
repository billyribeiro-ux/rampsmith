# ADR-225: The coverage disclosure: automated, partial and manual criteria

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-13 (reports and statement generator)

## Context

PLAN §11 "Coverage disclosure": "Every report lists which WCAG 2.2 A and AA criteria were tested
automatically, which partially, and which need a human. Axe's 'incomplete' results enter the
review queue rather than being dropped or counted as failures." PLAN §3 adds that every report
states that automated checks find only part of all issues, citing the axe-core figure. The
axe-core 4.14.0 README (read from the installed package on 18 October 2026): "With axe-core, you
can find **on average 57% of WCAG issues automatically**. Additionally, axe-core will return
elements as 'incomplete' where axe-core could not be certain, and manual review is needed."

WCAG 2.2 (W3C Recommendation, 12 December 2024, https://www.w3.org/TR/WCAG22/, read 18 October
2026) has 31 Level A and 24 Level AA success criteria once 4.1.1 Parsing, "obsolete and removed",
is left out. The page's text as fetched ended after 2.5.8, so the levels of 3.1.1 to 4.1.3 were
taken from the Recommendation's known structure and cross-checked against axe-core's level tags
where a rule exists (3.1.1 A, 3.1.2 AA, 3.3.2 A, 4.1.2 A); the test asserts 31 + 24.

## Decision

1. `src/wcag.ts` lists the 55 criteria with their levels; each short name is a catalog message
   (`wcag_1_4_10`), so translations can use the W3C's authorized wording.
2. The disclosure is an input: the criteria `automated` (the checks decide every testable
   condition), the criteria `partial`, the scan's `ruleset_version`, and the number of
   undecided results waiting in the review queue. Every A and AA criterion not named is
   "needs a person". The input is refused if it names a criterion outside WCAG 2.2 A and AA or
   names one twice.
3. `coverageFromRules` derives the disclosure from the rules a scan ran: a criterion with any
   rule is **partial**; it becomes **automated** only when the caller names it and a rule covers
   it. An automated rule can show that something fails but rarely that a criterion is met (alt
   text present is not alt text that describes the image), so nothing is "automated" by
   default. `criteriaFromAxeTags` reads axe-core's `wcag111`-style tags (principle and guideline
   are single digits in WCAG 2.2) and drops level tags, AAA criteria and 4.1.1.
4. Derived from axe-core 4.14.0's own rules alone, 23 A and AA criteria are partial and 32 need
   a person (`coverage.test.ts` asserts the count and a sample of each: 1.1.1, 1.3.1, 1.4.3,
   2.4.2, 3.1.1 and 4.1.2 partial; 1.2.3, 2.4.5, 3.2.6, 3.3.7 and 3.3.8 manual). axe-core's
   remaining SC tags are AAA (1.4.6, 2.2.4, 2.4.9, 3.2.5) or the removed 4.1.1. Rampsmith's
   custom rules (`packages/a11y-rules` on `ws/a11y-rules`) add 1.4.10, 2.1.2, 2.4.7 and 2.4.11
   when the engine passes them in.
5. Every report renders the three groups under their counts, the review-queue sentence, the
   ruleset, and the axe-core figure.

## Plan correction

- PLAN §11 "Coverage disclosure", append: "A criterion counts as tested in part whenever an
  automated rule covers it, and as tested automatically only when the ruleset's owner names it;
  by default none is (ADR-225). Reports show the count of results waiting for review."

## Consequences

- Reports never say a criterion is "tested automatically" unless someone decided it can be,
  which keeps the disclosure honest at the cost of a group that is usually empty.
- The engine owns the ruleset and passes its rule list (axe-core `getRules()` plus the custom
  catalog) at scan time; `packages/engine/src/wcag.ts` has `criteriaFromTags`, which keeps AAA
  criteria, so the reports filter again.

## Rejected alternatives

- A fixed table of "automatable" criteria in the package: it would drift from the ruleset that
  actually ran, and the first scan with a different ruleset would misreport.
