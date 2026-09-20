import {defineField, defineType} from 'sanity'

/**
 * How one ruling used a prior ruling.
 *
 * `relation` is the whole point of typing this instead of storing a bare reference. A
 * `distinguishes` is a cited precedent that was held *not* to apply, which is exactly
 * the "precedent-misleads" failure mode the eval harness scores. A flat array of
 * references cannot express that distinction, and the distinction is the story.
 *
 * Used in two places, deliberately:
 * - `case.proposal.precedents` - what the agent chose to cite (evidence, frozen for eval)
 * - `instruction.precedents`  - what the ruling actually relied on (the durable chain)
 */
export const precedent = defineType({
  name: 'precedent',
  title: 'Precedent',
  type: 'object',
  fields: [
    defineField({
      name: 'instruction',
      title: 'Instruction',
      type: 'reference',
      to: [{type: 'instruction'}],
      description:
        'The prior ruling being cited. Strong: when a precedent chain is what makes the argument, the citation must be real.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'relation',
      title: 'Relation',
      type: 'string',
      description: 'How this ruling used the cited one.',
      options: {
        list: [
          {title: 'Follows', value: 'follows'},
          {title: 'Distinguishes', value: 'distinguishes'},
          {title: 'Overrules', value: 'overrules'},
        ],
        layout: 'radio',
      },
      validation: (rule) => rule.required(),
    }),
  ],
  preview: {
    // `instruction._ref` rather than `instruction->._id`: both resolve to the referenced
    // document id, and the raw `_ref` selector is the one preview syntax that is
    // unambiguous without dereferencing.
    select: {
      relation: 'relation',
      instructionId: 'instruction._ref',
    },
    prepare: ({relation, instructionId}) => ({
      title: `${relation ?? 'no relation'}: ${instructionId ?? 'unresolved reference'}`,
    }),
  },
})
