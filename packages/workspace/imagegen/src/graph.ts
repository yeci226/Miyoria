// Builds a ComfyUI graph in API format in code: nodes get ids in the order they are added, and an
// output of a node is referenced as `[id, slot]`, which is how the API format links nodes.

import type { JsonValue } from "@miyoria/types";
import type { ComfyGraph } from "./comfy.js";

/** A link to output `slot` of node `id`, as the API format writes it. */
export type Link = [string, number];

export class GraphBuilder {
  readonly #graph: ComfyGraph = {};
  #next = 1;

  /** Adds a node and returns its id. */
  add(classType: string, inputs: Record<string, JsonValue | Link>, title?: string): string {
    const id = String(this.#next++);
    this.#graph[id] = {
      class_type: classType,
      inputs: inputs as Record<string, JsonValue>,
      ...(title ? { _meta: { title } } : {}),
    };
    return id;
  }

  /** Output `slot` of node `id`. */
  out(id: string, slot = 0): Link {
    return [id, slot];
  }

  build(): ComfyGraph {
    return structuredClone(this.#graph);
  }
}

/** Ids of the nodes that save pictures (`SaveImage`) in a graph, in id order. */
export function saveNodes(graph: ComfyGraph): string[] {
  return Object.entries(graph)
    .filter(([, node]) => node.class_type === "SaveImage")
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
