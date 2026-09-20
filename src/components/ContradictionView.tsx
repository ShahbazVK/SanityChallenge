import {Suspense} from 'react'
import {Badge, Card, Flex, Stack, Text} from '@sanity/ui'

import type {CaseDetail, CaseEventEntry, Proposal, Ruling} from '../types'
import {ClaimCardGrid, PrecedentList, StageBadge, formatDate, sourceTitle} from './ClaimsList'
import {ProposeActions} from './ProposeActions'

/**
 * The centre panel: everything known about one case.
 *
 * The view is driven by the case's DERIVED stage, so each stage asks a different question.
 * `detected` asks a human to rule from scratch, `proposed` shows what the agent thinks
 * first, `ruled` shows what was decided, `superseded` shows what was decided and that it
 * has since been replaced.
 *
 * `onProposed` is called after the offline proposer writes its proposal, so the parent can
 * react. It does not need to refetch anything: the dashboard's queries are live and re-read
 * on their own once the write lands.
 */
export function ContradictionView({
  detail,
  onProposed,
}: {
  detail: CaseDetail | null
  onProposed: () => void
}) {
  if (!detail) {
    return (
      <Stack space={4}>
        <Text size={1} weight="semibold" muted>
          CASE
        </Text>
        <Card border padding={4} radius={2}>
          <Text size={1} muted>
            Select a case on the left to inspect it.
          </Text>
        </Card>
      </Stack>
    )
  }

  const {stage, proposal, ruling} = detail

  return (
    <Stack space={4}>
      <Text size={1} weight="semibold" muted>
        CASE
      </Text>

      <Card border padding={4} radius={2}>
        <Stack space={3}>
          <Flex align="center" gap={2} justify="space-between" wrap="wrap">
            <Text size={2} weight="semibold">
              {detail.topicName ?? 'Untitled topic'}
            </Text>
            <StageBadge stage={stage} />
          </Flex>
          <Text muted size={0}>
            {detail._id} · detected by {detail.detectedBy ?? 'unknown'} on{' '}
            {formatDate(detail.detectedAt)}
          </Text>
        </Stack>
      </Card>

      {stage === 'superseded' && ruling ? (
        <Card border padding={4} radius={2} tone="primary">
          <Stack space={2}>
            <Text size={1} weight="semibold">
              Superseded
            </Text>
            <Text size={1}>
              {ruling.supersededBy
                ? `A later ruling on this topic (${ruling.supersededBy._id}) replaced this decision. The original is kept for the record.`
                : 'A later ruling on this topic replaced this decision.'}
            </Text>
          </Stack>
        </Card>
      ) : null}

      {stage === 'detected' ? <NoProposalPanel detail={detail} onProposed={onProposed} /> : null}
      {stage === 'proposed' && proposal ? <ProposalPanel proposal={proposal} /> : null}
      {ruling ? <RulingPanel ruling={ruling} /> : null}

      {detail.claims.length > 0 ? (
        <Stack space={3}>
          <Text size={0} weight="semibold" muted>
            CLAIMS IN CONFLICT
          </Text>
          <ClaimCardGrid
            claims={detail.claims}
            overruledIds={(ruling?.overruled ?? []).map((claim) => claim._id)}
            proposedId={proposal?.outcome?._id ?? null}
            winnerId={ruling?.winner?._id ?? null}
          />
        </Stack>
      ) : null}

      <AuditTrail events={detail.events} />
    </Stack>
  )
}

/**
 * A `detected` case has no proposal, so the button here is the way one gets made.
 *
 * It runs the OFFLINE proposer - `scripts/lib/propose.mjs`, a pure rule with no model call
 * and no key - rather than the LLM path, which needs a server. The write itself lives in
 * `ProposeActions`, inside its own Suspense boundary, so this panel stays presentational:
 * nothing it renders can suspend and blank the case out from under a reader.
 */
function NoProposalPanel({detail, onProposed}: {detail: CaseDetail; onProposed: () => void}) {
  return (
    <Card border padding={4} radius={2} tone="caution">
      <Stack space={3}>
        <Text size={1} weight="semibold">
          No proposal yet
        </Text>
        <Text size={1}>
          Nothing has proposed an outcome for this case, so there is no precedent research to
          review. You can resolve it directly, or have the agent propose one: the offline
          proposer ranks these claims by source authority, then review date, then confidence:
          a rule you can read, not a model call.
        </Text>
        <Suspense fallback={null}>
          <ProposeActions caseId={detail._id} claims={detail.claims} onProposed={onProposed} />
        </Suspense>
        {/* Outside the boundary on purpose: the footnote describes the rule, so it must stay
            readable even while the write component is suspended. */}
        <Text muted size={0}>
          Runs the deterministic rule (no model call). The LLM-backed proposer (openai/gpt-oss-120b
          on Groq) runs from the CLI and writes the same proposal shape.
        </Text>
      </Stack>
    </Card>
  )
}

function ProposalPanel({proposal}: {proposal: Proposal}) {
  return (
    <Card border padding={4} radius={2} tone="caution">
      <Stack space={4}>
        <Flex align="center" gap={2} justify="space-between" wrap="wrap">
          <Text size={1} weight="semibold">
            Agent proposal
          </Text>
          <Flex align="center" gap={2} wrap="wrap">
            {typeof proposal.confidence === 'number' ? (
              <Badge tone={proposal.confidence >= 0.75 ? 'positive' : 'caution'}>
                confidence {proposal.confidence}
              </Badge>
            ) : null}
            <Text muted size={0}>
              {proposal.model ?? 'unknown model'} · {formatDate(proposal.proposedAt)}
            </Text>
          </Flex>
        </Flex>

        <Stack space={2}>
          <Text size={0} weight="semibold" muted>
            PROPOSED OUTCOME
          </Text>
          <Card border padding={3} radius={2}>
            <Stack space={2}>
              <Text size={1}>{proposal.outcome?.statement ?? 'No outcome recorded'}</Text>
              <Flex align="center" gap={2} wrap="wrap">
                <Badge tone="primary">{proposal.outcome?.value ?? 'No value'}</Badge>
                <Text size={0} muted>
                  {sourceTitle(proposal.outcome)}
                </Text>
              </Flex>
            </Stack>
          </Card>
        </Stack>

        <Stack space={2}>
          <Text size={0} weight="semibold" muted>
            RATIONALE
          </Text>
          <Text size={1}>{proposal.rationale ?? 'No rationale recorded'}</Text>
        </Stack>

        <Stack space={2}>
          <Text size={0} weight="semibold" muted>
            PRECEDENTS CITED
          </Text>
          <PrecedentList precedents={proposal.precedents} />
        </Stack>
      </Stack>
    </Card>
  )
}

function RulingPanel({ruling}: {ruling: Ruling}) {
  return (
    <Card border padding={4} radius={2} tone="positive">
      <Stack space={4}>
        <Text size={1} weight="semibold">
          Ruling
        </Text>
        <Text size={1}>{ruling.resolution ?? 'No resolution text recorded'}</Text>

        {/* A ruling may establish a value that no claim asserted, in which case there is
            no winner to show and `outcomeValue` IS the answer. */}
        {!ruling.winner && ruling.outcomeValue ? (
          <Flex align="center" gap={2} wrap="wrap">
            <Text size={0} weight="semibold" muted>
              ESTABLISHED VALUE
            </Text>
            <Badge tone="primary">{ruling.outcomeValue}</Badge>
          </Flex>
        ) : null}

        <Stack space={2}>
          <Text size={0} weight="semibold" muted>
            PRECEDENTS RELIED ON
          </Text>
          <PrecedentList precedents={ruling.precedents} />
        </Stack>
      </Stack>
    </Card>
  )
}

/**
 * The event log for this case, oldest first.
 *
 * This is the raw material for the derived stage, so showing it makes the architecture
 * legible: you can read the case's stage off the last row.
 */
function AuditTrail({events}: {events: CaseEventEntry[]}) {
  if (events.length === 0) return null

  return (
    <Stack space={3}>
      <Text size={0} weight="semibold" muted>
        AUDIT TRAIL
      </Text>
      {events.map((event) => (
        <Card border padding={3} radius={2} key={event._id}>
          <Stack space={2}>
            <Flex align="center" gap={2} wrap="wrap">
              <Badge tone={event.to === 'ruled' ? 'positive' : 'default'}>
                {event.from ?? '∅'} → {event.to}
              </Badge>
              <Text size={0} muted>
                {event.actor?.kind ?? 'unknown'}
                {event.actor?.label ? ` · ${event.actor.label}` : ''} · {formatDate(event.at)}
              </Text>
            </Flex>
            {event.rationale ? (
              <Text size={1} muted>
                “{event.rationale}”
              </Text>
            ) : null}
          </Stack>
        </Card>
      ))}
    </Stack>
  )
}
