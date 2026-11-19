# Test: Add multiple Reliever questions

Plan: plan/2026-11-19-add-questions.md
Created: 2026-11-19
Status: Passed
Last run: 2026-11-19

Frozen contract: created before source edits. Only Result, Evidence, Status, Last run and Run log may change during verification.

## Scope and environment
Local Reliever question editor correction, existing Node runtime and native Brave. Browser fixture uses actual app script with startup disabled, synthetic in-memory state and no API writes. No database or new account required. Production deployment and complete shift/evidence lifecycle are outside this change.

## Preconditions
P1: node --version exits 0. Result: pass, v26.13.0

## C1 - Add, focus, limit and removal
- Run: node --test test/skill-questions.test.js from project root.
- Expect: zero failures or skips. Empty data-add-skill-question creates an editable row and focuses its prompt; eight-question maximum prevents another row; removal preserves at least one question. Add regression must fail before the fix.
- Result: pass
- Evidence: Before fix, Add and limit tests failed (no row and no limit message). After fix, node --test test/skill-questions.test.js: all three pass, zero failed/skipped; append focuses new prompt, eight bound reports limit, removal retains first.

## R1 - Syntax and existing save-route regressions
- Run: node --check public/app.js and node --test test/supabase-shift-save.test.js.
- Expect: both exit 0, no test failures or skips.
- Result: pass
- Evidence: node --check public/app.js exits 0. Combined targeted run: nine pass, zero failures/skips, including six Supabase save regression cases. These are mocked SQL checks, not proof of deployed API success.

## S1 - Cache delivery and bounded change
- Do: inspect public/index.html script URL and changed source diff, plus rollback in plan.
- Expect: script version changes from 20261115-10; only presence check and help text change in app.js; no API/schema/auth changes introduced by this task. Rollback restores old UI with a fresh asset version. Existing backend diff remains separate.
- Result: pass
- Evidence: Diff confirms only app.js presence check/help text plus index.html app.js?v=20261119-1 changed for this fix. Existing backend SQL diff is separate. No data/auth/schema edits. Rollback recorded in plan.

## M1 - Multiple questions in Brave
- Do: open isolated local fixture in visible Brave, click Add question, enter a second prompt, select Written details, then remove the second question.
- Expect: second editable row appears, retains prompt and Written details; removing it preserves the original row. No publish or API request.
- Result: pass
- Evidence: Visible native Brave file:///private/tmp/moonlight-question-editor-qa.html uses actual app.js with init disabled. Add created second focused prompt; entered Describe your relevant experience; selected Written details; AX confirmed both values. Remove removed second row and retained first prompt Are you available for this shift?. No publish.

## Coverage map
| Plan item | Checks |
| --- | --- |
| Step 1, add/focus/limits/removal | C1 |
| Step 1, existing submit/backend compatibility | R1, S1 |
| Step 1, cache delivery, rollback, no data/auth changes | S1 |
| Step 2 and visible multiple editable rows | M1 |
| Existing editor/model defaults | C1, M1, S1 |
| Local-only delivery | S1, M1 |

## Corrections
None.

## Run log

### Run 2026-11-19
Four checks passed plus precondition. No contract changes or coverage gaps. Existing full-suite baseline: 10 pass, one D1 Worker integration failure at test/worker.test.js:30 (undefined versus true); not repaired by this scoped change. Live single and weekly shift saves reproduced generic server error. No deploy performed; neither hosted behavior nor full shift/evidence lifecycle is claimed fixed.
