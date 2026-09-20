/**
 * The deterministic proposer.
 *
 * SINGLE SOURCE OF TRUTH for how the agent chooses an outcome. The seed precomputes
 * every proposal with this function, and (Phase 5) `src/agent/proposeOffline.ts` wraps
 * it for the in-browser "Propose ruling" button. One implementation, two callers, so the
 * eval scores the proposer we actually ship rather than a lookalike.
 *
 * The rule is TOTAL by construction - rule 4 guarantees a decision even when everything
 * else ties. That is deliberate (the demo must never hang), but it has a consequence
 * worth naming: the proposer can be confidently wrong. A rule-4 decision at confidence
 * 0.5 is a coin flip, and `case-cancellation-notice-1` exists precisely to show a human
 * overruling one.
 *
 * Rule priority:
 *   1. higher source-authority rank       (official > internal > external > community)
 *   2. more recent source.lastReviewedAt
 *   3. higher claim.confidence
 *   4. lexicographically smaller claim._id
 */

/** Authority levels, highest first. Unknown source types rank below everything. */
export const AUTHORITY_RANK = {
  official: 3,
  internal: 2,
  external: 1,
  community: 0,
}

/** Confidence the proposer reports, keyed by which rule actually decided. */
export const RULE_CONFIDENCE = {1: 0.9, 2: 0.75, 3: 0.6, 4: 0.5}

function authorityOf(claim) {
  return AUTHORITY_RANK[claim.source.sourceType] ?? -1
}

function dateOnly(value) {
  return String(value).slice(0, 10)
}

/** Total ordering: authority, then recency, then confidence, then id. */
function compareClaims(a, b) {
  const byAuthority = authorityOf(b) - authorityOf(a)
  if (byAuthority !== 0) return byAuthority

  const byRecency = String(b.source.lastReviewedAt).localeCompare(String(a.source.lastReviewedAt))
  if (byRecency !== 0) return byRecency

  const byConfidence = (b.confidence ?? 0) - (a.confidence ?? 0)
  if (byConfidence !== 0) return byConfidence

  return a._id.localeCompare(b._id)
}

/** Which rule separated the winner from the runner-up. */
function decidingRule(winner, runnerUp) {
  if (authorityOf(winner) !== authorityOf(runnerUp)) return 1
  if (winner.source.lastReviewedAt !== runnerUp.source.lastReviewedAt) return 2
  if ((winner.confidence ?? 0) !== (runnerUp.confidence ?? 0)) return 3
  return 4
}

function describeSource(claim) {
  return `${claim.source.title} (authority: ${claim.source.sourceType})`
}

function listPhrase(items) {
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The rationale names the actual sources and their authority levels, not just the rule.
 * A rationale that says "higher authority wins" teaches a reader nothing; the eval and
 * the writeup both need the concrete reasoning.
 */
function buildRationale({rule, winner, losers}) {
  switch (rule) {
    case 1:
      return (
        `The ${describeSource(winner)} takes precedence over ` +
        `${listPhrase(losers.map(describeSource))} per the source hierarchy.`
      )
    case 2:
      return (
        `Both sources carry equal authority (${winner.source.sourceType}), so the more ` +
        `recently reviewed source wins: ${winner.source.title} ` +
        `(reviewed ${dateOnly(winner.source.lastReviewedAt)}) over ` +
        `${listPhrase(
          losers.map(
            (claim) =>
              `${claim.source.title} (reviewed ${dateOnly(claim.source.lastReviewedAt)})`,
          ),
        )}.`
      )
    case 3:
      return (
        `Equal authority and review date, so the claim carrying higher confidence wins: ` +
        `${winner.source.title} (confidence ${winner.confidence}) over ` +
        `${listPhrase(losers.map((claim) => `${claim.source.title} (confidence ${claim.confidence})`))}.`
      )
    case 4:
      return (
        `All ${losers.length + 1} claims come from ${winner.source.title} with the same ` +
        `review date and the same confidence, so no rule in the hierarchy separates them. ` +
        `The tie was broken on claim id - a coin flip, not a judgement.`
      )
    default:
      throw new Error(`Unknown deciding rule: ${rule}`)
  }
}

/**
 * Picks the winning claim for a set of conflicting claims.
 *
 * @param {{claims: Array<{_id: string, value: string, confidence?: number,
 *   source: {_id: string, title: string, sourceType: string, lastReviewedAt?: string}}>}} args
 * @returns {{outcomeId: string, decidingRule: number, confidence: number, rationale: string}}
 */
export function proposeRule({claims}) {
  if (!Array.isArray(claims) || claims.length < 2) {
    throw new Error('proposeRule needs at least two claims to choose between.')
  }
  for (const claim of claims) {
    if (!claim.source || claim.source.sourceType == null) {
      throw new Error(`Claim ${claim._id} is missing source.sourceType; cannot rank it.`)
    }
  }

  const ranked = [...claims].sort(compareClaims)
  const [winner, runnerUp] = ranked
  const rule = decidingRule(winner, runnerUp)

  return {
    outcomeId: winner._id,
    decidingRule: rule,
    confidence: RULE_CONFIDENCE[rule],
    rationale: buildRationale({rule, winner, losers: ranked.slice(1)}),
  }
}

/**
 * Appends a hand-written precedent sentence to a rule-generated rationale.
 *
 * Precedent applicability is narrative, not derivable - the rule cannot know whether an
 * earlier ruling on another topic transfers - so the caller supplies the sentence and
 * this only handles the joining.
 */
export function withPrecedentNote(rationale, note) {
  return note ? `${rationale} ${note}` : rationale
}
