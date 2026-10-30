/**
 * Selecting and writing one language variant of a text predicate (#192),
 * including the cases Focus found: untagged selected as `null`, statement
 * order, fallbacks, case-equivalent tags and regional variants.
 */
import { describe, expect, it } from 'vitest';
import type { JsonLd } from '../results.js';
import {
  editTextVariant,
  patchTextVariant,
  selectTextVariant,
  type EditDefinition,
  type LanguageOrder,
  type TextVariant,
} from './index.js';

const NAME = 'https://schema.org/name';
const DESCRIPTION = 'https://schema.org/description';
const order: LanguageOrder = [null, 'de', 'de-*', 'en', 'en-*', '*'];
const node = (...terms: object[]): JsonLd => ({
  '@id': 'urn:a',
  [NAME]: terms,
});
const reversed = (resource: JsonLd): JsonLd => ({
  ...resource,
  [NAME]: [...(resource[NAME] as object[])].reverse(),
});

describe('selectTextVariant', () => {
  it.each([
    [
      'untagged first',
      [{ '@value': 'Plain' }, { '@value': 'Deutsch', '@language': 'de' }],
      null,
      'Plain',
    ],
    [
      'de before en',
      [
        { '@value': 'English', '@language': 'en' },
        { '@value': 'Deutsch', '@language': 'de' },
      ],
      'de',
      'Deutsch',
    ],
    [
      'a regional de before en',
      [
        { '@value': 'English', '@language': 'en' },
        { '@value': 'Schweiz', '@language': 'de-CH' },
      ],
      'de-ch',
      'Schweiz',
    ],
    [
      'other tags lexically, never by statement order',
      [
        { '@value': 'Italiano', '@language': 'it' },
        { '@value': 'Français', '@language': 'fr' },
      ],
      'fr',
      'Français',
    ],
    [
      'regional variants of one range lexically',
      [
        { '@value': 'Deutschland', '@language': 'de-DE' },
        { '@value': 'Österreich', '@language': 'de-AT' },
      ],
      'de-at',
      'Österreich',
    ],
  ])('selects %s in either order', (_name, terms, language, value) => {
    for (const resource of [node(...terms), reversed(node(...terms))])
      expect(selectTextVariant(resource, NAME, order)).toEqual({
        language,
        value,
        values: [value],
        ambiguous: false,
      });
  });

  it('keeps an untagged selection instead of falling back', () => {
    // The bug Focus fixed: `find(...) ?? fallback` treated a selected `null` as no match.
    const resource = node(
      { '@value': 'English', '@language': 'en' },
      { '@value': 'Plain' },
    );
    expect(selectTextVariant(resource, NAME, order).language).toBeNull();
  });

  it('compares tags case-insensitively but keeps regions distinct', () => {
    const resource = node(
      { '@value': 'Deutsch', '@language': 'DE' },
      { '@value': 'Deutschland', '@language': 'de-DE' },
    );
    expect(selectTextVariant(resource, NAME, ['de'])).toMatchObject({
      language: 'de',
      value: 'Deutsch',
    });
    // The app decides a region's priority.
    expect(selectTextVariant(resource, NAME, ['de-de', 'de'])).toMatchObject({
      language: 'de-de',
      value: 'Deutschland',
    });
  });

  it('reports values in one language, also under case-equivalent tags, as a conflict', () => {
    const resource = node(
      { '@value': 'Eins', '@language': 'de' },
      { '@value': 'Zwei', '@language': 'DE' },
      { '@value': 'One', '@language': 'en' },
    );
    expect(selectTextVariant(resource, NAME, order)).toEqual({
      language: 'de',
      value: null,
      values: ['Eins', 'Zwei'],
      ambiguous: true,
    });
  });

  it('without a value names the language a write creates', () => {
    const resource = node(
      { '@value': 'Svenska', '@language': 'sv' },
      { '@id': 'urn:not-text' },
    );
    expect(selectTextVariant(resource, NAME, ['de', 'en'])).toEqual({
      language: 'de',
      value: null,
      values: [],
      ambiguous: false,
    });
    expect(selectTextVariant({ '@id': 'urn:a' }, NAME, [null]).language).toBe(
      null,
    );
  });

  it('ignores typed literals and IRIs', () => {
    const resource = node(
      { '@value': '2026', '@type': 'http://www.w3.org/2001/XMLSchema#gYear' },
      { '@id': 'urn:x' },
      { '@value': 'Plain' },
    );
    expect(selectTextVariant(resource, NAME, order).value).toBe('Plain');
  });

  it('rejects an order it could not write with or does not understand', () => {
    expect(() => selectTextVariant(node(), NAME, ['*'])).toThrow(TypeError);
    expect(() => selectTextVariant(node(), NAME, ['de-*'])).toThrow(TypeError);
    expect(() => selectTextVariant(node(), NAME, ['de', 'd e'])).toThrow(
      TypeError,
    );
    expect(() => selectTextVariant(node(), 'name', ['de'])).toThrow(TypeError);
  });
});

describe('patchTextVariant', () => {
  const mixed = node(
    { '@value': 'Plain' },
    { '@value': 'Deutsch', '@language': 'DE' },
    { '@value': 'Deutschland', '@language': 'de-DE' },
    { '@value': 'English', '@language': 'en' },
    { '@value': '2026', '@type': 'http://www.w3.org/2001/XMLSchema#gYear' },
    { '@id': 'urn:x' },
  );

  it('writes nothing for an untouched variant, also with a non-lowercase tag', () => {
    const variant = selectTextVariant(mixed, NAME, ['de', 'en']);
    expect(variant.value).toBe('Deutsch');
    expect(patchTextVariant(mixed, NAME, variant)).toEqual({});
  });

  it('replaces only the selected variant and writes its tag in lower case', () => {
    const variant = selectTextVariant(mixed, NAME, ['de', 'en']);
    expect(
      patchTextVariant(mixed, NAME, editTextVariant(variant, 'Neu')),
    ).toEqual({
      [NAME]: [
        { '@value': 'Plain' },
        { '@value': 'Deutschland', '@language': 'de-DE' },
        { '@value': 'English', '@language': 'en' },
        { '@value': '2026', '@type': 'http://www.w3.org/2001/XMLSchema#gYear' },
        { '@id': 'urn:x' },
        { '@value': 'Neu', '@language': 'de' },
      ],
    });
  });

  it('replaces the untagged value without touching the tagged ones', () => {
    const variant = selectTextVariant(mixed, NAME, order);
    expect(variant.language).toBeNull();
    const patch = patchTextVariant(
      mixed,
      NAME,
      editTextVariant(variant, 'Changed'),
    );
    expect(patch[NAME]).toContainEqual({ '@value': 'Changed' });
    expect(patch[NAME]).not.toContainEqual({ '@value': 'Plain' });
    expect((patch[NAME] as object[]).length).toBe(6);
  });

  it('keeps a conflict until an explicit edit replaces every value in its language', () => {
    const resource = node(
      { '@value': 'Eins', '@language': 'de' },
      { '@value': 'Zwei', '@language': 'DE' },
      { '@value': 'One', '@language': 'en' },
    );
    const variant = selectTextVariant(resource, NAME, order);
    expect(patchTextVariant(resource, NAME, variant)).toEqual({});
    expect(
      patchTextVariant(resource, NAME, editTextVariant(variant, 'Zwei')),
    ).toEqual({
      [NAME]: [
        { '@value': 'One', '@language': 'en' },
        { '@value': 'Zwei', '@language': 'de' },
      ],
    });
  });

  it('removes the variant with null and the predicate once nothing is left', () => {
    const only = node({ '@value': 'Deutsch', '@language': 'de' });
    const variant = selectTextVariant(only, NAME, ['de']);
    expect(
      patchTextVariant(only, NAME, editTextVariant(variant, null)),
    ).toEqual({ [NAME]: null });
  });

  it('adds a first value in the order’s writing language', () => {
    const empty: JsonLd = { '@id': 'urn:a' };
    const variant = selectTextVariant(empty, NAME, ['de', 'en']);
    expect(
      patchTextVariant(empty, NAME, editTextVariant(variant, 'Neu')),
    ).toEqual({ [NAME]: [{ '@value': 'Neu', '@language': 'de' }] });
  });
});

describe('a custom definition with two selected variants', () => {
  type Draft = {
    readonly name: TextVariant;
    readonly description: TextVariant;
  };
  const definition: EditDefinition<Draft> = {
    read: (resource) => ({
      name: selectTextVariant(resource, NAME, order),
      description: selectTextVariant(resource, DESCRIPTION, order),
    }),
    patch: (resource, draft) => ({
      ...patchTextVariant(resource, NAME, draft.name),
      ...patchTextVariant(resource, DESCRIPTION, draft.description),
    }),
    valid: (draft) =>
      !draft.name.ambiguous && Boolean(draft.name.value?.trim()),
  };
  const resource: JsonLd = {
    '@id': 'urn:a',
    [NAME]: [
      { '@value': 'Task', '@language': 'en' },
      { '@value': 'Aufgabe', '@language': 'de' },
    ],
    [DESCRIPTION]: [
      { '@value': 'Eins', '@language': 'de' },
      { '@value': 'Zwei', '@language': 'de' },
    ],
  };

  it('an edit of one field does not rewrite the other, even while it conflicts', () => {
    const draft = definition.read(resource);
    expect(draft.name.value).toBe('Aufgabe');
    expect(draft.description.ambiguous).toBe(true);
    expect(definition.patch(resource, draft)).toEqual({});
    expect(
      definition.patch(resource, {
        ...draft,
        name: editTextVariant(draft.name, 'Neue Aufgabe'),
      }),
    ).toEqual({
      [NAME]: [
        { '@value': 'Task', '@language': 'en' },
        { '@value': 'Neue Aufgabe', '@language': 'de' },
      ],
    });
  });

  it('reads the same variants from either statement order', () => {
    const swapped: JsonLd = {
      ...resource,
      [NAME]: [...(resource[NAME] as object[])].reverse(),
    };
    expect(definition.read(swapped)).toEqual(definition.read(resource));
  });
});
