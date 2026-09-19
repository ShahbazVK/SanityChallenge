import {useState} from 'react'
import {useQuery} from '@sanity/sdk-react'
import {Badge, Box, Button, Card, Flex, Stack, Text} from '@sanity/ui'

/**
 * One query joins everything the history rows need — topic name, and both claims
 * with their source titles — so the view never fans out into per-row requests.
 */
const RESOLUTION_HISTORY_QUERY = `*[_type == "instruction"] | order(decidedAt desc) {
  _id,
  resolution,
  decidedBy,
  decidedAt,
  "topicName": appliesToTopic->name,
  "correctClaim": basedOnClaim->{statement, "sourceTitle": source->title},
  "overruledClaim": contradictsClaim->{statement, "sourceTitle": source->title}
}`

// Stable module-level identity so the SDK's option memoization never sees a change.
const RESOLUTION_HISTORY_OPTIONS = {query: RESOLUTION_HISTORY_QUERY}

type HistoryClaim = {
  statement: string | null
  sourceTitle: string | null
}

type HistoryEntry = {
  _id: string
  resolution: string | null
  decidedBy: string | null
  decidedAt: string | null
  topicName: string | null
  correctClaim: HistoryClaim | null
  overruledClaim: HistoryClaim | null
}

function formatDecidedAt(value: string | null): string {
  if (!value) return 'Date not recorded'

  const decidedAt = new Date(value)
  if (Number.isNaN(decidedAt.getTime())) return value

  return new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}).format(decidedAt)
}

function ClaimSummary({
  claim,
  label,
  tone,
}: {
  claim: HistoryClaim | null
  label: string
  tone: 'positive' | 'critical'
}) {
  return (
    <Card border padding={3} radius={2} tone={tone}>
      <Stack space={2}>
        <Text size={0} weight="semibold">
          {label}
        </Text>
        <Text size={1}>{claim?.statement ?? 'Claim statement not recorded'}</Text>
        <Text muted size={0}>
          {claim?.sourceTitle ?? 'Unknown source'}
        </Text>
      </Stack>
    </Card>
  )
}

function InstructionCard({instruction}: {instruction: HistoryEntry}) {
  const [isExpanded, setIsExpanded] = useState(false)

  return (
    <Card border padding={4} radius={2} shadow={1}>
      <Stack space={4}>
        <Stack space={3}>
          <Flex align="center" gap={2} justify="space-between" wrap="wrap">
            <Badge tone="primary">{instruction.topicName ?? 'Untitled topic'}</Badge>
            <Text muted size={0}>
              {formatDecidedAt(instruction.decidedAt)}
            </Text>
          </Flex>

          <Text size={2} weight="semibold">
            {instruction.resolution ?? 'No resolution text recorded'}
          </Text>

          <Text muted size={1}>
            {instruction.decidedBy ? `Decided by ${instruction.decidedBy}` : 'Decided by not recorded'}
          </Text>
        </Stack>

        <Button
          fontSize={1}
          mode="ghost"
          onClick={() => setIsExpanded((current) => !current)}
          padding={2}
          text={isExpanded ? 'Hide claims' : 'Show claims'}
        />

        {isExpanded ? (
          <Stack space={3}>
            <ClaimSummary claim={instruction.correctClaim} label="Correct claim" tone="positive" />
            <ClaimSummary claim={instruction.overruledClaim} label="Overruled claim" tone="critical" />
          </Stack>
        ) : null}
      </Stack>
    </Card>
  )
}

/**
 * Full-width governance record of every instruction ever recorded. Rendered inside
 * the dashboard's scrollable content area, so it must not impose its own 100vh.
 */
export function HistoryView() {
  const {data: instructions} = useQuery<HistoryEntry[]>(RESOLUTION_HISTORY_OPTIONS)

  return (
    <Flex justify="center" padding={4} paddingY={5}>
      <Box style={{maxWidth: '800px', width: '100%'}}>
        <Stack space={5}>
          <Stack space={2}>
            <Text size={2} weight="semibold">
              Resolution history
            </Text>
            <Text muted size={1}>
              Every instruction recorded from a human decision about a contradiction.
            </Text>
          </Stack>

          {instructions.length === 0 ? (
            <Card border padding={4} radius={2}>
              <Text muted size={1}>
                No decisions recorded yet. Resolve a contradiction to see it appear here.
              </Text>
            </Card>
          ) : (
            <Stack space={4}>
              {instructions.map((instruction) => (
                <InstructionCard instruction={instruction} key={instruction._id} />
              ))}
            </Stack>
          )}
        </Stack>
      </Box>
    </Flex>
  )
}
