import {Badge, Card, Flex, Stack, Text} from '@sanity/ui'

export type ClaimSummary = {
  _id: string
  statement: string | null
  value: string | null
  confidence: number | null
  topicRef: string | null
  topicName: string | null
  sourceTitle: string | null
}

export type ClaimGroup = {
  topicRef: string
  topicName: string
  claims: ClaimSummary[]
}

/** The distinct normalized values across a set of claims, ignoring blank ones. */
export function distinctClaimValues(claims: Array<{value: string | null}>): string[] {
  return [
    ...new Set(claims.map((claim) => claim.value).filter((value): value is string => Boolean(value))),
  ]
}

/**
 * Whether a set of claims about one topic needs a human decision.
 *
 * `value` is the normalized comparison key: "14 days" vs "30 days" needs triage, while
 * "30 days" vs "30 days" is agreement and must NOT be flagged — that is the whole point
 * of the field. A claim with no value cannot be confirmed to agree with anything, so it
 * counts as needing triage rather than being silently treated as consistent.
 */
export function hasValueConflict(claims: Array<{value: string | null}>): boolean {
  if (claims.length < 2) return false

  const everyClaimHasValue = claims.every((claim) => Boolean(claim.value))
  return distinctClaimValues(claims).length !== 1 || !everyClaimHasValue
}

/** How many topics sit in each of the three states the value rule can produce. */
export type ClaimCounts = {
  /** Two or more unresolved claims asserting different values — real triage work. */
  conflicts: number
  /** Two or more unresolved claims whose values all match — nothing to decide. */
  consistent: number
  /** Exactly one unresolved claim, so there is nothing to compare it against. */
  single: number
}

type ClaimsListProps = {
  groups: ClaimGroup[]
  counts: ClaimCounts
  selectedClaimId: string | null
  onSelectClaim: (claimId: string) => void
}

export function ClaimsList({groups, counts, selectedClaimId, onSelectClaim}: ClaimsListProps) {
  const totalClaims = groups.reduce((sum, group) => sum + group.claims.length, 0)

  return (
    <Stack space={4}>
      {/* The whole dataset in one line. Only the first number is triage work: a topic
          whose sources agree reads as `consistent`, not as a conflict. */}
      <Text muted size={0}>
        {counts.conflicts} conflicts · {counts.consistent} consistent · {counts.single} single-source
      </Text>

      <Flex align="center" justify="space-between">
        <Text size={1} weight="semibold" muted>
          UNRESOLVED CLAIMS
        </Text>
        <Badge tone={totalClaims > 0 ? 'caution' : 'positive'}>{totalClaims}</Badge>
      </Flex>

      {totalClaims === 0 ? (
        <Card padding={4} radius={2} tone="positive" border>
          <Text size={1}>All clear — no contradictions to triage.</Text>
        </Card>
      ) : (
        groups.map((group) => (
          <Stack key={group.topicRef} space={2}>
            <Text size={1} weight="semibold">
              {group.topicName}
            </Text>
            {group.claims.map((claim) => {
              const isSelected = claim._id === selectedClaimId
              return (
                <Card
                  key={claim._id}
                  padding={3}
                  radius={2}
                  tone={isSelected ? 'primary' : 'default'}
                  border
                  onClick={() => onSelectClaim(claim._id)}
                  role="button"
                  tabIndex={0}
                  style={{cursor: 'pointer'}}
                >
                  <Stack space={2}>
                    <Text size={1}>{claim.statement ?? 'Untitled claim'}</Text>
                    <Text size={0} muted>
                      {claim.sourceTitle ?? 'Unknown source'}
                      {typeof claim.confidence === 'number' ? ` · confidence ${claim.confidence}` : ''}
                    </Text>
                  </Stack>
                </Card>
              )
            })}
          </Stack>
        ))
      )}
    </Stack>
  )
}
