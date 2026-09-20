import {useState} from 'react'
import {useQuery} from '@sanity/sdk-react'
import {Badge, Box, Button, Card, Flex, Stack, Text} from '@sanity/ui'

import {HISTORY_RULED_OPTIONS} from '../queries'
import type {ClaimSummary, HistoryRow} from '../types'
import {PrecedentList, formatDate, sourceTitle} from './ClaimsList'

/**
 * The governance record.
 *
 * This iterates `caseEvent` documents where `to == "ruled"`, not instructions. The event
 * log is where the transition actually happened and it records WHO moved the case, so a
 * ruling that nobody recorded as an event cannot exist - and a case closed without a
 * ruling (`case-data-retention-1`, a dismissed false positive) still appears, with no
 * instruction to show.
 */
export function HistoryView() {
  const {data: rows} = useQuery<HistoryRow[]>(HISTORY_RULED_OPTIONS)

  return (
    <Flex justify="center" padding={4} paddingY={5}>
      <Box style={{maxWidth: '860px', width: '100%'}}>
        <Stack space={5}>
          <Stack space={2}>
            <Text size={2} weight="semibold">
              Resolution history
            </Text>
            <Text muted size={1}>
              Every recorded transition to a ruling, newest first, including who made it.
            </Text>
          </Stack>

          {rows.length === 0 ? (
            <Card border padding={4} radius={2}>
              <Text muted size={1}>
                No decisions recorded yet. Resolve a case to see it appear here.
              </Text>
            </Card>
          ) : (
            <Stack space={4}>
              {rows.map((row) => (
                <HistoryCard key={row._id} row={row} />
              ))}
            </Stack>
          )}
        </Stack>
      </Box>
    </Flex>
  )
}

function ClaimLine({
  claim,
  label,
  tone,
}: {
  claim: ClaimSummary
  label: string
  tone: 'positive' | 'critical'
}) {
  return (
    <Card border padding={3} radius={2} tone={tone}>
      <Stack space={2}>
        <Text size={0} weight="semibold">
          {label}
        </Text>
        <Text size={1} style={tone === 'critical' ? {textDecoration: 'line-through'} : undefined}>
          {claim.statement ?? 'Claim statement not recorded'}
        </Text>
        <Text muted size={0}>
          {sourceTitle(claim)}
          {claim.value ? ` · ${claim.value}` : ''}
        </Text>
      </Stack>
    </Card>
  )
}

function HistoryCard({row}: {row: HistoryRow}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const {instruction} = row
  const isSuperseded = Boolean(instruction?.supersededBy)

  return (
    <Card border padding={4} radius={2} shadow={1}>
      <Stack space={4}>
        <Stack space={3}>
          <Flex align="center" gap={2} justify="space-between" wrap="wrap">
            <Flex align="center" gap={2} wrap="wrap">
              <Badge tone="primary">{row.topicName ?? 'Untitled topic'}</Badge>
              {instruction ? null : <Badge tone="caution">No ruling recorded</Badge>}
              {isSuperseded ? <Badge tone="caution">Superseded</Badge> : null}
            </Flex>
            <Text muted size={0}>
              {formatDate(row.at)}
            </Text>
          </Flex>

          <Text size={2} weight="semibold">
            {instruction?.resolution ?? row.rationale ?? 'No resolution text recorded'}
          </Text>

          <Text muted size={1}>
            {row.actor?.label
              ? `Decided by ${row.actor.label}`
              : `Decided by ${row.actor?.kind ?? 'an unknown actor'}`}
          </Text>

          {isSuperseded ? (
            <Text muted size={1}>
              Superseded by a later ruling on this topic ({instruction?.supersededBy}).
            </Text>
          ) : null}
        </Stack>

        <Button
          fontSize={1}
          mode="ghost"
          onClick={() => setIsExpanded((current) => !current)}
          padding={2}
          text={isExpanded ? 'Hide detail' : 'Show detail'}
        />

        {isExpanded ? (
          <Stack space={3}>
            {instruction?.winner ? (
              <ClaimLine claim={instruction.winner} label="Upheld" tone="positive" />
            ) : instruction?.outcomeValue ? (
              <Card border padding={3} radius={2} tone="positive">
                <Stack space={2}>
                  <Text size={0} weight="semibold">
                    Established value
                  </Text>
                  <Text size={1}>{instruction.outcomeValue}</Text>
                </Stack>
              </Card>
            ) : null}

            {(instruction?.overruled ?? []).map((claim) => (
              <ClaimLine claim={claim} key={claim._id} label="Overruled" tone="critical" />
            ))}

            <Stack space={2}>
              <Text size={0} weight="semibold" muted>
                PRECEDENTS RELIED ON
              </Text>
              <PrecedentList precedents={instruction?.precedents ?? []} />
            </Stack>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  )
}
