import {defineField, defineType} from 'sanity'

/**
 * A single statement extracted from a source.
 */
export const claim = defineType({
  name: 'claim',
  title: 'Claim',
  type: 'document',
  fields: [
    defineField({
      name: 'statement',
      title: 'Statement',
      type: 'text',
      validation: (rule) => rule.required(),
    }),
    /**
     * The normalized comparison key for this claim.
     *
     * The point of the schema is that a human can compare claims about the same topic
     * at a glance. `statement` is free text; `value` is the normalized key it reduces
     * to. Two claims asserting "14 days" and "30 days" for the same topic are in
     * contradiction; two claims both asserting "30 days" are consistent, and the app
     * must not flag them as conflicting.
     */
    defineField({
      name: 'value',
      title: 'Value',
      type: 'string',
      description:
        'The normalized value this claim asserts about the topic. E.g. "14 days", "30 days", "7 years". Two claims with different values are in contradiction; two claims with the same value agree.',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'source',
      title: 'Source',
      type: 'reference',
      to: [{type: 'source'}],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'topic',
      title: 'Topic',
      type: 'reference',
      to: [{type: 'topic'}],
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'status',
      title: 'Status',
      type: 'string',
      options: {
        list: [
          {title: 'Unresolved', value: 'unresolved'},
          {title: 'Resolved', value: 'resolved'},
        ],
        layout: 'radio',
      },
      initialValue: 'unresolved',
      validation: (rule) =>
        rule
          .custom<string>((status, context) => {
            if (status === 'resolved' && !context.document?.resolvedBy) {
              return 'Status is "resolved", but no resolving instruction is set.'
            }
            return true
          })
          .warning(),
    }),
    defineField({
      name: 'resolvedBy',
      title: 'Resolved by',
      type: 'reference',
      to: [{type: 'instruction'}],
      description: 'Set when status becomes "resolved".',
    }),
    defineField({
      name: 'confidence',
      title: 'Confidence',
      type: 'number',
      description: 'How confident the source is in this claim, from 0 to 1.',
      validation: (rule) => rule.min(0).max(1),
    }),
  ],
  preview: {
    select: {
      title: 'statement',
      sourceTitle: 'source.title',
      status: 'status',
    },
    prepare: ({title, sourceTitle, status}) => ({
      title,
      subtitle: `${sourceTitle} · ${status}`,
    }),
  },
})
