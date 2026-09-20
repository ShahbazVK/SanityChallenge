EVAL REPORT - deterministic proposer
========================================

Generated: 2026-09-20T00:56:59.082Z
Cases evaluated: 7

Each case pairs the agent proposal with the ruling a human (or the seed simulated human) actually made. A match means the human upheld the very claim the agent proposed.

## OVERALL ACCURACY

- Outcome match: 6 / 7 (86%)
- Overrides: 1 / 7 (14%)

## PRODUCERS

- offline-heuristic-v1: 7

## BY CONFIDENCE BUCKET

- 0.9-1.0: 5 / 5 (100%) - high-confidence
- 0.7-0.9: 1 / 1 (100%)
- 0.5-0.7: 0 / 0 (n/a)
- 0.0-0.5: 0 / 1 (0%) - coin flips

## BY CATEGORY

- authority-beats-recency (rule 1: source authority separated the claims): 3 / 3 (100%) - 0 overridden
- newer-supersedes-older (rule 2: review date separated them): 1 / 1 (100%) - 0 overridden
- confidence-decides (rule 3: claim confidence separated them): 0 / 0 (n/a) - no cases
- precedent-applies (citation: agent cited a precedent as "follows" and the human endorsed it): 1 / 1 (100%) - 0 overridden
- precedent-misleads (citation: agent cited a precedent as "follows" and the human did not endorse it): 1 / 1 (100%) - 0 overridden
- true-tie (rule 4: nothing separated them; broken on claim id): 0 / 1 (0%) - 1 overridden
- unclassified (-: no confidence recorded): 0 / 0 (n/a) - no cases

Categories are exclusive, so the case counts sum to the total. A case where the agent leaned on a precedent is grouped by the precedent, because that is the more specific fact.

Read the two precedent categories carefully: the CATEGORY is about the citation, while the percentage is about the OUTCOME. A case can sit in `precedent-misleads` and still count as a match - the agent followed a precedent the human rejected and reached the same answer anyway. Its argument failed; its conclusion did not. `case-gift-card-expiry-1` is that case.

## PRECEDENT HANDLING

- Cases with agent citations: 2
- Cases where human agreed: 1 / 2 (50%)
- Citation precision (agent citations the ruling also made): 1 / 2 (50%)
- Citation recall (ruling citations the agent also made): 1 / 2 (50%)

A citation counts only when the instruction AND the relation match: citing a ruling as "follows" when the human cited it as "distinguishes" is a disagreement, not a hit.

> NOTE: recall here is depressed by the app's bookkeeping as well as by the proposer. When a human overrides the agent with a different outcome, the ruling deliberately does NOT inherit the agent's citations, so those rulings have nothing to recall. Read precision as the proposer's precision; recall is a joint measure of both.

## COVERAGE

- Cases in the dataset: 12
- Evaluated (proposal AND ruling): 7
- Skipped: 5
  - case-data-retention-1 (no proposal)
  - case-refund-processing-time-1 (no proposal)
  - case-refund-window-1 (no ruling)
  - case-shipping-cost-1 (no ruling)
  - case-warranty-period-1 (no ruling)

A case is evaluated only when it has BOTH artifacts. A case still at `detected` has no proposal, and a case dismissed as a false positive never got a ruling - neither can be scored against human judgement.

## CROSS-CHECK

- Derived override agrees with the recorded `payload.approvedProposal`: 7 / 7 (100%)

This does not score the agent - it checks the HARNESS. The override column is derived by comparing outcomes, and the event log records the same fact independently; if those two ever diverged, the numbers above would be suspect.

## CASE-BY-CASE

```
case-account-deletion-1 agent: 60 days human: 60 days ✓  [authority-beats-recency, confidence 0.9]
case-cancellation-notice-1 agent: 30 days human: 45 days (value) ✗  [true-tie, confidence 0.5]
case-gift-card-expiry-1 agent: 12 months human: 12 months ✓  [precedent-misleads, confidence 0.9]
case-price-match-window-1 agent: 30 days human: 30 days ✓  [authority-beats-recency, confidence 0.9]
case-refund-method-1 agent: Original payment method human: Original payment method ✓  [authority-beats-recency, confidence 0.9]
case-trial-period-1 agent: 30 days human: 30 days ✓  [newer-supersedes-older, confidence 0.75]
case-trial-period-2 agent: 30 days human: 30 days ✓  [precedent-applies, confidence 0.9]
```

## READING THESE NUMBERS

1. n = 7. Every percentage moves about 10 points per case, so treat these as directions rather than measurements, and do not quote a single category as a rate.
2. A ruling that establishes a NEW VALUE (`outcomeValue`) can never count as a match: the agent proposes a claim, and `case.proposal` has no field for a value. Those cases are misses by construction, not by disagreement.
3. Rule attribution is inferred from the confidence the proposer reported, which is exact only for the deterministic proposer - see PRODUCERS for a warning when it is not.
4. The buckets are coarse because the proposer only reports four confidence values (0.9, 0.75, 0.6, 0.5), so the middle buckets can be empty and the outer ones can hold a single case.

