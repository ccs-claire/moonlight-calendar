# Plan: Add multiple Reliever questions

Created: 2026-11-19
Status: Implemented
Size: Small, T3 existing production UI
Input: requirement stated directly

## Overview
Restore Add question in the Reliever post form so authors can enter multiple required questions.

## Assumptions applied
- Use the existing Required skills section, Yes or No / Written details types, and existing limit of eight questions. No new question model or calendar-wide fields.
- Local implementation only; deployment is a separate step.

## Non-goals
No production writes, new accounts, schema changes, calendar-save backend changes, or unrelated Worker-test repairs.

## Current State
Live Brave testing confirmed Add question does nothing. public/app.js skillQuestionsEditor renders an empty data-add-skill-question attribute. Its delegated click handler tests the empty string for truthiness, so never inserts a row. The same handler already supports removal, focus, and an eight-row limit. The availability-form submit handler serializes each row; Supabase validates one through eight questions and the two existing types.

## Proposed Changes
Check attribute presence in the existing handler. Clarify the help text with the eight-question limit and response types. Bump app.js cache version in public/index.html. Add test/skill-questions.test.js to execute the real delegated handler with empty-attribute events, append/focus, removal, and bounds. No dependencies, API, auth, or data changes. TEST database step: none. PROD database step: none.

## Steps
1. Add a regression test and run it before the fix. Correct the handler and help text, then bump the script version. Verify: C1, R1, S1.
2. Browser-check the actual corrected app script in an isolated local HTML fixture with startup disabled and no API writes. Add a second question, choose Written details, enter a prompt, remove it, and verify a single question remains. Verify: M1.

## Testing
- C1: node --test test/skill-questions.test.js tests the actual registered click handler including the eight-question bound and minimum-one removal guard.
- R1: node --check public/app.js and node --test test/supabase-shift-save.test.js.
- S1: inspect script cache bump and restricted diff. Rollback restores the prior handler/help text and uses a new asset version. No schema rollback.
- M1: native Brave interaction with the actual app script in a disposable /private/tmp HTML fixture.

## Validation and Success Criteria
Add works for the actual empty data attribute; row limit and removal stay intact; changed JavaScript parses; script URL changes; Brave visibly shows multiple editable question rows. Checks C1, R1, S1, M1 cover all criteria and steps.

## Notes
Small existing-handler correction. Dedicated design and production-readiness sections omitted: no new architecture or external calls. Existing esc rendering, server validation, permissions, and submission serialization remain in place. public/app.js skillQuestionRow, skillQuestionsEditor, availability-form and delegated click handler are the direct connections; public/index.html controls cache delivery. Full-suite baseline was 10 pass, 1 failure in obsolete D1 Worker integration at worker.test.js:30; report it separately. Live shift saves also fail; an existing local backend fix is not deployed. No production fix is claimed.

## Implementation notes
2026-11-19: Corrected empty-attribute handler, clarified limits/types, bumped JS URL, and added three handler tests. Regression observed failing before source correction. Nine targeted tests and syntax/diff checks pass. Native Brave fixture verified add, focus, Written details, prompt retention and removal. No deployment, schema, auth, API or production data changes. Independent read-only review confirmed the minimal scope. Coverage map audited with no gaps. Existing full-suite D1 failure remains out of scope.
