import {defineArrayMember, defineField, defineType} from 'sanity'

import {ACTOR_KINDS_DETECTED_BY} from './workflowStages'

/**
 * One detected contradiction, and the work of resolving it.
 *
 * NOTE ON THE EXPORT NAME: `case` is a JavaScript reserved word, so this type cannot
 * follow the `export const <typename>` convention the other schema files use. The
 * document's `name` is still `case`.
 *
 * There is deliberately NO `stage` field. A case's stage is a pure function of its own
 * artifacts plus one cross-document lookup (see the derivation query in the design doc),
 * so storing it would introduce a second source of truth that can silently drift - the
 * same trap as `claim.resolvedBy`. For the same reason there is no `ruling`
 * back-pointer: the ruling is whatever instruction names this case.
 */
export const caseType = defineType({
  name: 'case',
  title: 'Case',
  type: 'document',
  fields: [
    defineField({
      name: 'topic',
      title: 'Topic',
      type: 'reference',
      to: [{type: 'topic'}],
      description: 'The subject of the dispute.',
      validation: (rule) => rule.required(),
    }),
    /**
     * A SNAPSHOT of which claims were in conflict when the case was opened.
     *
     * This is a historical fact, not denormalization: later claims on the same topic
     * must not retroactively change what this case was about. Deriving the set as "the
     * topic's claims right now" would rewrite history.
     */
    defineField({
      name: 'claims',
      title: 'Claims in conflict',
      type: 'array',
      of: [defineArrayMember({type: 'reference', to: [{type: 'claim'}]})],
      description: 'The claims that disagree, captured at detection time. At least two.',
      validation: (rule) => rule.required().min(2),
    }),
    /**
     * The agent's proposal. Absent until a proposal exists - which is precisely how the
     * `detected` stage is represented, so no separate "draft" document type is needed.
     *
     * The internal requirements are enforced by a validator on this object rather than
     * by `required()` on its nested fields. Nested `required()` rules have ambiguous
     * behaviour when the parent object is absent, and a case with no proposal (including
     * the one the demo deliberately leaves at `detected`) must be clean, not error-covered.
     */
    defineField({
      name: 'proposal',
      title: 'Proposal',
      type: 'object',
      fields: [
        defineField({
          name: 'outcome',
          title: 'Outcome',
          type: 'reference',
          to: [{type: 'claim'}],
          description: 'The claim the agent says wins. Must be one of the claims above.',
        }),
        defineField({
          name: 'rationale',
          title: 'Rationale',
          type: 'text',
          description: 'Why the agent chose that outcome, in prose.',
        }),
        defineField({
          name: 'confidence',
          title: 'Confidence',
          type: 'number',
          description: 'How sure the agent is, from 0 to 1.',
          validation: (rule) => rule.min(0).max(1),
        }),
        defineField({
          name: 'precedents',
          title: 'Precedents cited',
          type: 'array',
          of: [defineArrayMember({type: 'precedent'})],
          description: 'Prior rulings the agent cited, and how it used each.',
        }),
        defineField({
          name: 'proposedAt',
          title: 'Proposed at',
          type: 'datetime',
        }),
        defineField({
          name: 'model',
          title: 'Model',
          type: 'string',
          description:
            'Which producer wrote this, e.g. "offline-heuristic-v1" or an LLM id. Kept so the eval can attribute proposals.',
        }),
        defineField({
          name: 'promptVersion',
          title: 'Prompt version',
          type: 'string',
          description: 'Prompt revision, so a proposal stays reproducible after the prompt changes.',
        }),
      ],
      validation: (rule) =>
        rule.custom((value) => {
          // No proposal at all means the case is still `detected`. That is legal.
          if (!value) return true

          const proposal = value as {
            outcome?: unknown
            rationale?: unknown
            confidence?: unknown
            proposedAt?: unknown
          }

          if (!proposal.outcome) return 'A proposal needs an outcome claim.'
          if (!proposal.rationale) return 'A proposal needs a rationale.'
          if (typeof proposal.confidence !== 'number') {
            return 'A proposal needs a confidence between 0 and 1.'
          }
          if (!proposal.proposedAt) return 'A proposal needs a proposedAt timestamp.'
          return true
        }),
    }),
    defineField({
      name: 'detectedBy',
      title: 'Detected by',
      type: 'string',
      options: {
        list: ACTOR_KINDS_DETECTED_BY.map((value) => ({title: value, value})),
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'detectedAt',
      title: 'Detected at',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
      validation: (rule) => rule.required(),
    }),
  ],
  preview: {
    // A hint, not a derived stage: the list view cannot run the cross-document
    // supersession lookup, so it shows only whether a proposal exists.
    select: {
      topicName: 'topic.name',
      claims: 'claims',
      outcome: 'proposal.outcome._ref',
      detectedBy: 'detectedBy',
    },
    prepare: ({topicName, claims, outcome, detectedBy}) => ({
      title: topicName ?? 'Untitled topic',
      subtitle: `${(claims ?? []).length} claims · ${outcome ? 'proposed' : 'detected'} · by ${detectedBy ?? 'unknown'}`,
    }),
  },
})
