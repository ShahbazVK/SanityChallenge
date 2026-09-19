import {defineField, defineType} from 'sanity'

/**
 * A document/source of truth that claims are extracted from.
 */
export const source = defineType({
  name: 'source',
  title: 'Source',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'url',
      title: 'URL',
      type: 'url',
    }),
    defineField({
      name: 'sourceType',
      title: 'Source type',
      type: 'string',
      options: {
        list: [
          {title: 'Internal', value: 'internal'},
          {title: 'External', value: 'external'},
          {title: 'Official', value: 'official'},
          {title: 'Community', value: 'community'},
        ],
      },
    }),
    defineField({
      name: 'content',
      title: 'Content',
      type: 'text',
      description: 'A summary or excerpt of the source material.',
    }),
    defineField({
      name: 'lastReviewedAt',
      title: 'Last reviewed at',
      type: 'datetime',
    }),
  ],
})
