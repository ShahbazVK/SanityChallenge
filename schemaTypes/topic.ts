import {defineField, defineType} from 'sanity'

/**
 * The subject a claim or instruction is about.
 * The slug is the stable identifier, so "refund-window", "refund window" and
 * "Refund-Window" all resolve to the same topic document.
 */
export const topic = defineType({
  name: 'topic',
  title: 'Topic',
  type: 'document',
  fields: [
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: 'The stable identifier for this topic, e.g. "refund-window".',
      options: {
        source: 'name',
      },
      // `required` is the only rule needed here: uniqueness is enforced natively
      // by the slug type's built-in validator, and `unique()` is not part of the
      // `SlugRule` type.
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
    }),
  ],
})
