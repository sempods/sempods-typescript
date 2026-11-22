import { useMessages } from '@sempods/app-sdk/react';

/** The Markdown field's own texts, in the SDK provider's language. */
const texts = {
  en: {
    addText: 'Add text',
    edit: 'Edit text',
    preview: 'Preview',
    formatting: 'Formatting',
    heading: 'Heading',
    bold: 'Bold',
    italic: 'Italic',
    bulletList: 'Bulleted list',
    numberedList: 'Numbered list',
    link: 'Link',
  },
  de: {
    addText: 'Text hinzufügen',
    edit: 'Text bearbeiten',
    preview: 'Vorschau',
    formatting: 'Formatierung',
    heading: 'Überschrift',
    bold: 'Fett',
    italic: 'Kursiv',
    bulletList: 'Aufzählung',
    numberedList: 'Nummerierte Liste',
    link: 'Link',
  },
};

/** The texts `MarkdownField` shows; `labels` replaces any of them. */
export type MarkdownFieldLabels = (typeof texts)['en'];

export function useMarkdownTexts(): MarkdownFieldLabels {
  return useMessages(texts);
}
