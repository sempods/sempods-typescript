import { RDF_TYPE } from '../iri.js';
import type { JsonLd } from '../results.js';
import {
  RDF_NIL,
  subjectOf,
  termKey,
  type Graph,
  type Quad,
  type Subject,
  type Term,
} from './terms.js';

/*
 * Quads as canonical flattened node objects (internal), the shape the SDK
 * hands to callers: one node object per subject and graph, `@type` an array
 * of IRIs, and every other value an array of `{"@id"}`, `{"@value"}` or
 * `{"@list"}` objects.
 */

export interface NodeMap {
  /** The `@id` of a subject: its IRI, or the label given to a blank node. */
  id(subject: Subject): string;
  /** A term as a canonical value object. */
  value(term: Term): JsonLd;
  /** The node object of `subject` in `graph`, created as `{"@id"}` on first use. */
  node(graph: Graph, subject: Subject): Record<string, unknown>;
  /** Adds one statement to a node object; an rdf:type node goes into `@type`. */
  add(node: Record<string, unknown>, predicate: string, object: Term): void;
  /** The node objects of `graph`, in the order of their first use. */
  nodes(graph: Graph): JsonLd[];
}

/** An empty node map; `label` names each blank node by its dataset `id`. */
export function nodeMap(label: (id: string) => string): NodeMap {
  const graphs = new Map<Graph, Map<string, Record<string, unknown>>>();
  const id = (s: Subject) => (s.kind === 'iri' ? s.value : label(s.id));
  const value = (term: Term): JsonLd => {
    switch (term.kind) {
      case 'iri':
      case 'blank':
        return { '@id': id(term) };
      case 'literal':
        return term.value;
      case 'list':
        return { '@list': term.items.map(value) };
    }
  };
  const nodesIn = (graph: Graph) => {
    let nodes = graphs.get(graph);
    if (!nodes) graphs.set(graph, (nodes = new Map()));
    return nodes;
  };
  return {
    id,
    value,
    node(graph, subject) {
      const nodes = nodesIn(graph);
      const key = termKey(subject);
      let node = nodes.get(key);
      if (!node) nodes.set(key, (node = { '@id': id(subject) }));
      return node;
    },
    add(node, predicate, object) {
      // The empty list is the IRI rdf:nil, so it is a type like any IRI.
      if (
        predicate === RDF_TYPE &&
        object.kind === 'list' &&
        object.items.length === 0
      )
        ((node['@type'] ??= []) as string[]).push(RDF_NIL);
      else if (
        predicate === RDF_TYPE &&
        (object.kind === 'iri' || object.kind === 'blank')
      )
        ((node['@type'] ??= []) as string[]).push(id(object));
      else ((node[predicate] ??= []) as JsonLd[]).push(value(object));
    },
    nodes: (graph) => [...nodesIn(graph).values()],
  };
}

/**
 * A dataset as flattened expanded JSON-LD: the default graph's node objects,
 * a named graph's statements under `@graph` of its name's node object (JSON-LD
 * 1.1 flattening), so each `@id` appears once at the top level.
 */
export function flatten(
  quads: readonly Quad[],
  label: (id: string) => string,
): JsonLd[] {
  const map = nodeMap(label);
  const names: string[] = [];
  for (const quad of quads) {
    if (quad.g !== undefined && !names.includes(quad.g)) names.push(quad.g);
    map.add(map.node(quad.g, quad.s), quad.p, quad.o);
  }
  for (const name of names)
    map.node(undefined, subjectOf(name))['@graph'] = map.nodes(name);
  return map.nodes(undefined);
}
