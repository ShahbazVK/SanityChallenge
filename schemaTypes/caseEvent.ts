import {defineField, defineType} from 'sanity'

import {ACTOR_KINDS, STAGES} from './workflowStages'

/**
 * An append-only record of one case transition.
 *
 * This IS the event log. Every move a case makes, by either actor, lands here, which is
 * what makes "both actors move the case through the same state transitions" auditable
 * rather than aspirational. The History view iterates these documents.
 *
 * `from` and `to` are STRINGS, not references to a stage-definition document. An audit
 * log must record what the stage was at that moment, immutably; a reference would
 * re-read today's definition, and renaming a stage would silently rewrite history.
 *
 * Never updated, only appended. Sanity cannot enforce that, so it is a convention plus a
 * seed-time check.
 */
export const caseEvent = defineType({
  name: 'caseEvent',
  title: 'Case event',
  type: 'document',
  fields: [
    defineField({
      name: 'case',
      title: 'Case',
      type: 'reference',
      to: [{type: 'case'}],
      description: 'The case this transition belongs to.',
      validation: (rule) => rule.required(),
    }),
    /**
     * The stage the case left. Leave empty for the creation event, which has no
     * predecessor - an unset `from` serialises as null.
     */
    defineField({
      name: 'from',
      title: 'From',
      type: 'string',
      description: 'Leave empty for the creation event (no predecessor).',
      options: {
        list: STAGES.map((value) => ({title: value, value})),
        layout: 'radio',
      },
      // `options.list` constrains the Studio UI but not the API, so the vocabulary is
      // re-asserted here for writes that bypass the Studio (the seed, the agent script).
      validation: (rule) =>
        rule.custom((value) =>
          value == null || (STAGES as readonly string[]).includes(value)
            ? true
            : `Must be empty or one of: ${STAGES.join(', ')}`,
        ),
    }),
    defineField({
      name: 'to',
      title: 'To',
      type: 'string',
      options: {
        list: STAGES.map((value) => ({title: value, value})),
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'actor',
      title: 'Actor',
      type: 'object',
      description: 'Who moved the case. `kind` is the discriminator this whole track rests on.',
      fields: [
        defineField({
          name: 'kind',
          title: 'Kind',
          type: 'string',
          options: {
            list: ACTOR_KINDS.map((value) => ({title: value, value})),
            layout: 'radio',
          },
        }),
        defineField({
          name: 'id',
          title: 'ID',
          type: 'string',
          description:
            'Sanity user id for humans (useCurrentUser().id), or a model id for agents. A string, not a reference: users are project members rather than documents, and an audit row must survive any future user deletion.',
        }),
        defineField({
          name: 'label',
          title: 'Label',
          type: 'string',
          description: 'Display name captured at the time of the transition.',
        }),
      ],
      validation: (rule) =>
        rule.required().custom((value) => {
          // `required` above already reports absence; this only checks the inner shape,
          // so an empty actor is not reported twice.
          if (!value) return true
          return (value as {kind?: unknown}).kind ? true : 'An actor needs a kind.'
        }),
    }),
    defineField({
      name: 'at',
      title: 'At',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'rationale',
      title: 'Rationale',
      type: 'text',
      description: 'On an override: why the human departed from the proposal.',
    }),
    defineField({
      name: 'payload',
      title: 'Payload',
      type: 'object',
      description:
        'Audit snapshot of the moment. Ids are stored as STRINGS, not references: a snapshot records what was true then, so it should not track a live document, and payload references to `claim` would add a second inbound edge to claims and make every claim-derivation query depend on staying `_type`-scoped.',
      fields: [
        defineField({
          name: 'approvedProposal',
          title: 'Approved the proposal',
          type: 'boolean',
          description: 'True when the human accepted the agent proposal unchanged.',
        }),
        defineField({
          name: 'agentOutcomeId',
          title: 'Agent outcome (claim id)',
          type: 'string',
          description: 'What the agent proposed, captured at rule time. The eval reads this.',
        }),
        defineField({
          name: 'humanOutcomeId',
          title: 'Human outcome (claim id)',
          type: 'string',
          description: 'What the human ruled. Differs from the agent outcome on an override.',
        }),
        defineField({
          name: 'note',
          title: 'Note',
          type: 'text',
          description: 'Free-form context for this transition.',
        }),
      ],
    }),
  ],
  preview: {
    select: {
      from: 'from',
      to: 'to',
      label: 'actor.label',
      kind: 'actor.kind',
    },
    prepare: ({from, to, label, kind}) => ({
      title: `${from ?? '∅'} → ${to ?? '?'}`,
      subtitle: `${kind ?? 'unknown'}${label ? ` · ${label}` : ''}`,
    }),
  },
})
