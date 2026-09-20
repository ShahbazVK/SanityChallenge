import {Badge, Card, Flex, Stack, Text} from '@sanity/ui'

import type {CaseStage, ClaimSummary, PrecedentCitation} from '../types'

/**
 * The distinct normalized values across a set of claims, ignoring blank ones.
 *
 * `value` is the comparison key - "14 days" vs "30 days" needs triage; "30 days" vs
 * "30 days" is agreement and must NOT be flagged. That is the entire point of the field.
 */
export function distinctClaimValues(claims: Array<{value: string | null}>): string[] {
  return [
    ...new Set(claims.map((claim) => claim.value).filter((value): value is string => Boolean(value))),
  ]
}

/**
 * Whether a set of claims needs a human decision.
 *
 * A claim with no value cannot be confirmed to agree with anything, so it counts as
 * needing triage rather than being silently treated as consistent.
 */
export function hasValueConflict(claims: Array<{value: string | null}>): boolean {
  if (claims.length < 2) return false

  const everyClaimHasValue = claims.every((claim) => Boolean(claim.value))
  return distinctClaimValues(claims).length !== 1 || !everyClaimHasValue
}

export const STAGE_LABELS: Record<CaseStage, string> = {
  detected: 'Needs a proposal',
  proposed: 'Awaiting your ruling',
  ruled: 'Ruled',
  superseded: 'Superseded',
}

const STAGE_TONES: Record<CaseStage, 'default' | 'primary' | 'positive' | 'caution' | 'critical'> = {
  detected: 'default',
  proposed: 'caution',
  ruled: 'positive',
  superseded: 'primary',
}

export function StageBadge({stage}: {stage: CaseStage}) {
  return <Badge tone={STAGE_TONES[stage]}>{STAGE_LABELS[stage]}</Badge>
}

export function sourceTitle(claim: ClaimSummary | null): string {
  return claim?.source?.title ?? 'Unknown source'
}

export function formatDate(value: string | null): string {
  if (!value) return 'Date not recorded'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(date)
}

/** How a claim is positioned by the case it belongs to. */
export type ClaimRole = 'winner' | 'overruled' | 'proposed' | 'in-conflict' | 'agreeing'

const CLAIM_ROLE_META: Record<
  ClaimRole,
  {tone: 'default' | 'primary' | 'positive' | 'critical' | 'caution'; label: string}
> = {
  winner: {tone: 'positive', label: '✓ Upheld'},
  overruled: {tone: 'critical', label: 'Overruled'},
  proposed: {tone: 'caution', label: 'Agent proposes this'},
  'in-conflict': {tone: 'critical', label: 'Conflicting claim'},
  agreeing: {tone: 'positive', label: 'Agreeing claim'},
}

/**
 * One claim, as a card. Purely presentational: it takes data rather than a document
 * handle, so it never suspends and there is no per-card fetch to churn.
 */
export function ClaimCard({claim, role}: {claim: ClaimSummary; role: ClaimRole}) {
  const meta = CLAIM_ROLE_META[role]
  const isOverruled = role === 'overruled'

  return (
    <Card border padding={4} radius={2} shadow={1} tone={meta.tone} style={{flex: 1, minWidth: '240px'}}>
      <Stack space={3}>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <Text size={1} weight="semibold" style={isOverruled ? {textDecoration: 'line-through'} : undefined}>
          {claim.statement ?? 'Untitled claim'}
        </Text>
        <Flex align="center" gap={2} wrap="wrap">
          <Badge tone="primary">{claim.value ?? 'No value'}</Badge>
          <Text size={0} muted>
            {sourceTitle(claim)}
            {claim.source?.sourceType ? ` · ${claim.source.sourceType}` : ''}
          </Text>
        </Flex>
        <Text size={0} muted>
          {typeof claim.confidence === 'number' ? `Confidence ${claim.confidence}` : 'Confidence not stated'}
        </Text>
      </Stack>
    </Card>
  )
}

/**
 * The case's claims side by side.
 *
 * `winnerId` / `overruledIds` come from the ruling when one exists; otherwise claims are
 * described by whether their values disagree, which is the pre-ruling view.
 */
export function ClaimCardGrid({
  claims,
  winnerId,
  overruledIds,
  proposedId,
}: {
  claims: ClaimSummary[]
  winnerId?: string | null
  overruledIds?: string[]
  proposedId?: string | null
}) {
  const inConflict = hasValueConflict(claims)

  function roleFor(claim: ClaimSummary): ClaimRole {
    if (winnerId && claim._id === winnerId) return 'winner'
    if (overruledIds?.includes(claim._id)) return 'overruled'
    if (!winnerId && proposedId && claim._id === proposedId) return 'proposed'
    return inConflict ? 'in-conflict' : 'agreeing'
  }

  return (
    <Flex align="stretch" gap={3} wrap="wrap">
      {claims.map((claim) => (
        <ClaimCard claim={claim} key={claim._id} role={roleFor(claim)} />
      ))}
    </Flex>
  )
}

/** Cited precedents, with the relation made explicit - `distinguishes` is the story. */
export function PrecedentList({precedents}: {precedents: PrecedentCitation[] | null | undefined}) {
  // GROQ returns null rather than [] for an unset array field, so every array projection
  // in this app is treated as possibly-null at the boundary.
  const list = precedents ?? []

  if (list.length === 0) {
    return (
      <Text muted size={0}>
        No precedents cited.
      </Text>
    )
  }

  return (
    <Stack space={2}>
      {list.map((precedent, index) => (
        <Card border padding={3} radius={2} key={precedent.instructionId ?? `precedent-${index}`}>
          <Stack space={2}>
            <Flex align="center" gap={2} wrap="wrap">
              <Badge
                tone={
                  precedent.relation === 'distinguishes'
                    ? 'critical'
                    : precedent.relation === 'overrules'
                      ? 'caution'
                      : 'positive'
                }
              >
                {precedent.relation ?? 'no relation'}
              </Badge>
              <Text size={0} muted>
                {precedent.instructionTopic ?? 'Unknown topic'} ·{' '}
                {precedent.instructionId ?? 'unknown instruction'}
              </Text>
            </Flex>
            {precedent.instructionResolution ? (
              <Text size={1}>{precedent.instructionResolution}</Text>
            ) : null}
          </Stack>
        </Card>
      ))}
    </Stack>
  )
}
