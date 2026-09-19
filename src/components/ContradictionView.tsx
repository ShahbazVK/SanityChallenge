import {Suspense, memo, useMemo} from 'react'
import {type DocumentHandle, useDocumentProjection} from '@sanity/sdk-react'
import {Badge, Card, Flex, Spinner, Stack, Text} from '@sanity/ui'
import {distinctClaimValues, hasValueConflict, type ClaimSummary} from './ClaimsList'

type ClaimCardData = {
  statement: string | null
  value: string | null
  confidence: number | null
  status: string | null
  sourceTitle: string | null
}

type ContradictionViewProps = {
  selectedClaim: ClaimSummary | null
  claims: DocumentHandle[]
  topicName: string | null
  /** The topic's unresolved claims — the ones the verdict is actually about. */
  unresolvedClaims: ClaimSummary[]
}

// Stable module-level identity: the projection string is constant, and the options
// object below is memoized so the SDK never sees a changed handle on re-render.
const CLAIM_CARD_PROJECTION = '{statement, value, confidence, status, "sourceTitle": source->title}'

const ClaimCard = memo(function ClaimCard({
  handle,
  isConflicting,
  isSelected,
}: {
  handle: DocumentHandle
  isConflicting: boolean
  isSelected: boolean
}) {
  const options = useMemo(() => ({...handle, projection: CLAIM_CARD_PROJECTION}), [handle])
  const {data} = useDocumentProjection<ClaimCardData>(options)

  const isResolved = data.status === 'resolved'
  // Only a genuine value disagreement reads as alarming; an unresolved claim whose
  // value matches its siblings is simply agreeing, not a problem.
  const tone = isResolved ? 'positive' : isConflicting ? 'critical' : 'default'
  const statusLabel = isResolved ? 'Resolved' : isConflicting ? 'Conflicting claim' : 'Agreeing claim'

  return (
    <Card border padding={4} radius={2} shadow={1} tone={tone} style={{flex: 1}}>
      <Stack space={3}>
        <Flex align="center" gap={2} justify="space-between">
          <Badge tone={tone}>{statusLabel}</Badge>
          {isSelected ? <Badge tone="primary">Selected</Badge> : null}
        </Flex>
        <Text size={1} weight="semibold">
          {data.statement ?? 'Untitled claim'}
        </Text>
        <Flex align="center" gap={2} wrap="wrap">
          <Badge tone="primary">{data.value ?? 'No value'}</Badge>
          <Text size={0} muted>
            {data.sourceTitle ?? 'Unknown source'}
          </Text>
        </Flex>
        <Text size={0} muted>
          {typeof data.confidence === 'number' ? `Confidence ${data.confidence}` : 'Confidence not stated'}
        </Text>
      </Stack>
    </Card>
  )
})

export function ContradictionView({
  selectedClaim,
  claims,
  topicName,
  unresolvedClaims,
}: ContradictionViewProps) {
  if (!selectedClaim) {
    return (
      <Stack space={4}>
        <Text size={1} weight="semibold" muted>
          CONTRADICTION VIEW
        </Text>
        <Card border padding={4} radius={2}>
          <Text size={1} muted>
            Select a claim on the left to inspect its topic.
          </Text>
        </Card>
      </Stack>
    )
  }

  // The verdict is judged on the normalized `value` of the topic's unresolved claims,
  // not on how many claims happen to exist: two sources saying "30 days" agree.
  const hasConflict = hasValueConflict(unresolvedClaims)
  const agreeingValues = distinctClaimValues(unresolvedClaims)
  const isConsistent = !hasConflict && unresolvedClaims.length > 1

  return (
    <Stack space={4}>
      <Text size={1} weight="semibold" muted>
        CONTRADICTION VIEW
      </Text>

      <Card border padding={4} radius={2}>
        <Stack space={3}>
          <Text size={0} muted>
            {topicName ?? 'Untitled topic'}
          </Text>
          <Text size={2} weight="semibold">
            {selectedClaim.statement ?? 'Untitled claim'}
          </Text>
          <Flex align="center" gap={3} wrap="wrap">
            <Badge tone="default">{selectedClaim.sourceTitle ?? 'Unknown source'}</Badge>
            <Text size={1} muted>
              {typeof selectedClaim.confidence === 'number'
                ? `Confidence ${selectedClaim.confidence}`
                : 'Confidence not stated'}
            </Text>
          </Flex>
        </Stack>
      </Card>

      {unresolvedClaims.length > 1 ? (
        <Stack space={3}>
          <Flex align="center" gap={2}>
            {hasConflict ? (
              <>
                <Badge tone="critical">⚠ Conflict</Badge>
                <Text muted size={1}>
                  {unresolvedClaims.length} unresolved claims with {agreeingValues.length} different
                  values.
                </Text>
              </>
            ) : (
              <>
                <Badge tone="positive">✓ Consistent</Badge>
                <Text muted size={1}>
                  {unresolvedClaims.length} sources agree on “{agreeingValues[0]}”.
                </Text>
              </>
            )}
          </Flex>
          <Flex align="stretch" gap={3} wrap="wrap">
            {claims.map((handle) => (
              <Suspense
                key={handle.documentId}
                fallback={
                  <Card border padding={4} radius={2} style={{flex: 1}}>
                    <Spinner />
                  </Card>
                }
              >
                <ClaimCard
                  handle={handle}
                  isConflicting={hasConflict}
                  isSelected={handle.documentId === selectedClaim._id}
                />
              </Suspense>
            ))}
          </Flex>
        </Stack>
      ) : (
        <Card border padding={4} radius={2} tone="positive">
          <Text size={1}>No conflicts detected for this topic.</Text>
        </Card>
      )}
    </Stack>
  )
}
