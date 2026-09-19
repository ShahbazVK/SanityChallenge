import {defineField, defineType} from 'sanity'

/**
 * A human decision resolving a contradiction. Applies to future entries.
 */
export const instruction = defineType({
  name: 'instruction',
  title: 'Instruction',
  type: 'document',
  fields: [
    defineField({
      name: 'resolution',
      title: 'Resolution',
      type: 'text',
      description: "The human's ruling.",
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'appliesToTopic',
      title: 'Applies to topic',
      type: 'reference',
      to: [{type: 'topic'}],
      description: 'The topic this instruction governs.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'basedOnClaim',
      title: 'Based on claim',
      type: 'reference',
      to: [{type: 'claim'}],
      description: 'The claim that was chosen as correct.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'contradictsClaim',
      title: 'Contradicts claim',
      type: 'reference',
      to: [{type: 'claim'}],
      description: 'The claim that was overruled.',
    }),
    defineField({
      name: 'decidedBy',
      title: 'Decided by',
      type: 'string',
    }),
    defineField({
      name: 'decidedAt',
      title: 'Decided at',
      type: 'datetime',
      initialValue: () => new Date().toISOString(),
    }),
  ],
  preview: {
    select: {
      title: 'resolution',
      topicName: 'appliesToTopic.name',
      decidedAt: 'decidedAt',
    },
    prepare: ({title, topicName, decidedAt}) => ({
      title,
      subtitle: `${topicName} · ${decidedAt}`,
    }),
  },
})
