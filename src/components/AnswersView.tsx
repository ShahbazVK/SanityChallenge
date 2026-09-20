import {Suspense, useEffect, useMemo, useState} from 'react'
import {useQuery} from '@sanity/sdk-react'
import {Badge, Card, Flex, Stack, Text} from '@sanity/ui'

import {
  TOPICS_WITH_ANSWERS_OPTIONS,
  canonicalAnswerOptions,
  supersededChainOptions,
} from '../queries'
import type {CanonicalAnswer, SupersededRuling, TopicWithAnswer} from '../types'
import {PrecedentList, formatDate, sourceTitle} from './ClaimsList'

/**
 * The consumer panel: what a system reading this dataset would answer RIGHT NOW.
 *
 * Every other tab shows the machinery. This one shows the point of it - the current
 * canonical value for a topic, which ruling established it, and what that ruling replaced.
 *
 * Nothing here is stored. The answer IS the one instruction nothing supersedes, so
 * resolving a case changes this panel with no synchronisation step in between.
 */
export function AnswersView() {
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null)

  return (
    <Flex align="stretch" style={{minHeight: '100%'}}>
      <Card borderRight flex={1} padding={3} style={{overflowY: 'auto'}}>
        <TopicList onSelectTopic={setSelectedTopicId} selectedTopicId={selectedTopicId} />
      </Card>
      <Card flex={2} padding={4} style={{overflowY: 'auto'}}>
        <CanonicalAnswerPanel topicId={selectedTopicId} />
      </Card>
    </Flex>
  )
}

/** One query: every topic that currently has an answer. */
function TopicList({
  onSelectTopic,
  selectedTopicId,
}: {
  onSelectTopic: (topicId: string) => void
  selectedTopicId: string | null
}) {
  const {data: rows} = useQuery<TopicWithAnswer[]>(TOPICS_WITH_ANSWERS_OPTIONS)

  // Defensive: the supersession predicate should make this one row per topic. A duplicate
  // would render a topic twice and make the selection ambiguous, so the first row wins.
  const topics = useMemo(() => {
    const byTopic = new Map<string, TopicWithAnswer>()
    for (const row of rows) {
      const topicRef = row.topicRef
      if (!topicRef || byTopic.has(topicRef)) continue
      byTopic.set(topicRef, row)
    }
    return [...byTopic.values()]
  }, [rows])

  // Report the first topic up, so the panel is never empty on arrival.
  useEffect(() => {
    if (topics.length === 0) return
    if (selectedTopicId && topics.some((topic) => topic.topicRef === selectedTopicId)) return

    const first = topics[0]
    if (first) onSelectTopic(first.topicRef)
  }, [onSelectTopic, selectedTopicId, topics])

  return (
    <Stack space={4}>
      <Stack space={2}>
        <Flex align="center" justify="space-between">
          <Text size={1} weight="semibold" muted>
            ANSWERS
          </Text>
          <Badge tone="positive">{topics.length}</Badge>
        </Flex>
        <Text muted size={0}>
          Topics with a current ruling. This is what a consumer system would be served.
        </Text>
      </Stack>

      {topics.length === 0 ? (
        <Card border padding={4} radius={2}>
          <Text muted size={1}>
            No topic has a ruling yet. Resolve a case to establish one.
          </Text>
        </Card>
      ) : (
        <Stack space={2}>
          {topics.map((topic) => {
            const isSelected = topic.topicRef === selectedTopicId

            return (
              <Card
                border
                key={topic.topicRef}
                onClick={() => onSelectTopic(topic.topicRef)}
                padding={3}
                radius={2}
                role="button"
                style={{cursor: 'pointer'}}
                tabIndex={0}
                tone={isSelected ? 'primary' : 'default'}
              >
                <Stack space={2}>
                  <Text size={1} weight="semibold">
                    {topic.topicName ?? 'Untitled topic'}
                  </Text>
                  <Badge tone={topic.value ? 'positive' : 'default'}>
                    {topic.value ?? 'no value'}
                  </Badge>
                </Stack>
              </Card>
            )
          })}
        </Stack>
      )}
    </Stack>
  )
}

/**
 * One query: the canonical answer for the selected topic.
 *
 * The panel distinguishes the two shapes an answer can take, because they mean different
 * things: an UPHELD CLAIM (green - one source won the argument) versus an ESTABLISHED VALUE
 * (blue - a human ruled that no claim was right, so the value exists only because of the
 * ruling). The colour is the fastest way to see which kind of answer you are looking at.
 */
function CanonicalAnswerPanel({topicId}: {topicId: string | null}) {
  // Memoized so a re-render never hands the SDK a new options object for the same topic.
  const options = useMemo(() => canonicalAnswerOptions(topicId ?? ''), [topicId])
  const {data: answer} = useQuery<CanonicalAnswer | null>(options)

  if (!answer) {
    return (
      <Stack space={4}>
        <Text size={1} weight="semibold" muted>
          CANONICAL ANSWER
        </Text>
        <Card border padding={4} radius={2}>
          <Text size={1} muted>
            {topicId ? 'This topic has no current ruling.' : 'Select a topic on the left.'}
          </Text>
        </Card>
      </Stack>
    )
  }

  const isEstablishedValue = answer.winner === null

  return (
    <Stack space={5}>
      <Stack space={2}>
        <Text size={1} weight="semibold" muted>
          CANONICAL ANSWER
        </Text>
        <Text size={3} weight="semibold">
          {answer.topicName ?? 'Untitled topic'}
        </Text>
        {answer.topicDescription ? (
          <Text muted size={1}>
            {answer.topicDescription}
          </Text>
        ) : null}
      </Stack>

      {/* The payoff: the largest type on the screen, in the positive tone. */}
      <Card border padding={5} radius={2} shadow={1} tone="positive">
        <Stack space={4}>
          <Flex align="center" gap={2} wrap="wrap">
            <Badge tone="positive">Current answer</Badge>
            <Badge tone={isEstablishedValue ? 'primary' : 'positive'}>
              {isEstablishedValue ? 'established by ruling' : 'upheld claim'}
            </Badge>
          </Flex>
          <Text size={4} weight="semibold">
            {answer.value ?? 'No value recorded'}
          </Text>
          <Text size={1}>{answer.resolution ?? 'No resolution text recorded'}</Text>
        </Stack>
      </Card>

      <Stack space={3}>
        <Text size={0} weight="semibold" muted>
          ESTABLISHED BY
        </Text>
        <Card border padding={3} radius={2}>
          <Flex align="center" gap={3} justify="space-between" wrap="wrap">
            <Stack space={2}>
              <Text size={1}>{answer.decidedBy ?? 'Decided by not recorded'}</Text>
              <Text muted size={0}>
                {formatDate(answer.decidedAt)}
              </Text>
            </Stack>
            <Text muted size={0}>
              {answer._id}
            </Text>
          </Flex>
        </Card>
      </Stack>

      <Stack space={3}>
        <Text size={0} weight="semibold" muted>
          BASED ON
        </Text>
        {answer.winner ? (
          <Card border padding={3} radius={2} tone="positive">
            <Stack space={2}>
              <Text size={1}>{answer.winner.statement ?? 'Claim statement not recorded'}</Text>
              <Flex align="center" gap={2} wrap="wrap">
                <Badge tone="positive">{answer.winner.value ?? 'No value'}</Badge>
                <Text muted size={0}>
                  {sourceTitle(answer.winner)}
                  {answer.winner.source?.sourceType ? ` · ${answer.winner.source.sourceType}` : ''}
                </Text>
              </Flex>
            </Stack>
          </Card>
        ) : (
          <Card border padding={3} radius={2} tone="primary">
            <Stack space={2}>
              <Text size={1}>
                Established by ruling: no claim asserted this value, so there is no source to
                cite.
              </Text>
              <Text muted size={0}>
                Every claim in the case was overruled.
              </Text>
            </Stack>
          </Card>
        )}

        {answer.overruled.length > 0 ? (
          <Stack space={2}>
            <Text muted size={0}>
              No longer applies:
            </Text>
            {answer.overruled.map((claim) => (
              <Card border key={claim._id} padding={3} radius={2} tone="critical">
                <Stack space={2}>
                  <Text size={1} style={{textDecoration: 'line-through'}}>
                    {claim.statement ?? 'Claim statement not recorded'}
                  </Text>
                  <Flex align="center" gap={2} wrap="wrap">
                    <Badge tone="critical">{claim.value ?? 'No value'}</Badge>
                    <Text muted size={0}>
                      {sourceTitle(claim)}
                    </Text>
                  </Flex>
                </Stack>
              </Card>
            ))}
          </Stack>
        ) : null}
      </Stack>

      <Stack space={3}>
        <Text size={0} weight="semibold" muted>
          PRECEDENTS CITED
        </Text>
        <PrecedentList precedents={answer.precedents} />
      </Stack>

      {/* Its own boundary: this is a second query, and it must not hold up the answer. */}
      <Suspense fallback={null}>
        <SupersededChain topicId={topicId} />
      </Suspense>
    </Stack>
  )
}

/**
 * One query: the rulings this topic has replaced, collapsed by default.
 *
 * The current answer is the point of the panel, so the history that produced it is folded
 * away - but it is one click from being visible, because "how did we get here" is exactly
 * the question a governance tool should be able to answer.
 */
function SupersededChain({topicId}: {topicId: string | null}) {
  const options = useMemo(() => supersededChainOptions(topicId ?? ''), [topicId])
  const {data: rows} = useQuery<SupersededRuling[]>(options)
  const [isOpen, setIsOpen] = useState(false)

  if (rows.length === 0) return null

  return (
    <Stack space={2}>
      <Flex
        align="center"
        aria-expanded={isOpen}
        gap={2}
        onClick={() => setIsOpen((current) => !current)}
        role="button"
        style={{cursor: 'pointer'}}
        tabIndex={0}
      >
        <Text aria-hidden="true" muted size={1}>
          {isOpen ? '▾' : '▸'}
        </Text>
        <Text muted size={0} weight="semibold">
          SUPERSEDED CHAIN · {rows.length} PRIOR {rows.length === 1 ? 'RULING' : 'RULINGS'}
        </Text>
      </Flex>

      {isOpen
        ? rows.map((row) => (
            <Card border key={row._id} padding={3} radius={2}>
              <Stack space={2}>
                <Flex align="center" gap={2} wrap="wrap">
                  <Badge tone="default">{row.value ?? 'no value'}</Badge>
                  <Text muted size={0}>
                    {formatDate(row.decidedAt)} · {row.decidedBy ?? 'decided by unknown'}
                  </Text>
                </Flex>
                <Text size={1}>{row.resolution ?? 'No resolution text recorded'}</Text>
                <Text muted size={0}>
                  Replaced by {row.supersededBy ?? 'a later ruling'}
                </Text>
              </Stack>
            </Card>
          ))
        : null}
    </Stack>
  )
}
