import { useMessages } from '@sempods/app-sdk/react';

/** The Markdown field's own texts, in the SDK provider's language. */
const texts = {
  en: {
    addText: 'Add text',
    edit: 'Edit text',
    preview: 'Preview',
    formatting: 'Formatting',
    heading: 'Heading',
    subheading: 'Subheading',
    bold: 'Bold',
    italic: 'Italic',
    strikethrough: 'Strikethrough',
    bulletList: 'Bulleted list',
    numberedList: 'Numbered list',
    link: 'Link',
    undo: 'Undo',
    redo: 'Redo',
    address: 'Link address',
    apply: 'Apply',
    removeLink: 'Remove link',
    markdownOnly:
      'This text has parts such as code or a quote, so you edit it as Markdown.',
  },
  de: {
    addText: 'Text hinzufügen',
    edit: 'Text bearbeiten',
    preview: 'Vorschau',
    formatting: 'Formatierung',
    heading: 'Überschrift',
    subheading: 'Zwischenüberschrift',
    bold: 'Fett',
    italic: 'Kursiv',
    strikethrough: 'Durchgestrichen',
    bulletList: 'Aufzählung',
    numberedList: 'Nummerierte Liste',
    link: 'Link',
    undo: 'Rückgängig',
    redo: 'Wiederholen',
    address: 'Link-Adresse',
    apply: 'Übernehmen',
    removeLink: 'Link entfernen',
    markdownOnly:
      'Dieser Text enthält Teile wie Code oder ein Zitat, daher bearbeitest du ihn als Markdown.',
  },
};

/** The texts `MarkdownField` shows; `labels` replaces any of them. */
export type MarkdownFieldLabels = (typeof texts)['en'];

export function useMarkdownTexts(): MarkdownFieldLabels {
  return useMessages(texts);
}
