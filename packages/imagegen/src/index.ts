// @miyoria/imagegen: pictures made on a ComfyUI server (docs/design/imagegen.md). The module
// provides `ImageGen` (`ImageGenKey`, in `@miyoria/types`); the client, the adapters and the
// workflow files are exported for tests and tools.

export {
  ComfyClient,
  type ComfyClientOptions,
  ComfyError,
  type ComfyErrorKind,
  type ComfyGraph,
  type ComfyImageRef,
  type ComfyNode,
  type ComfyProgress,
  type ComfyQueue,
  type ComfyRun,
  type ComfyStats,
} from "./comfy.js";
export {
  type ImageGenConfig,
  ImageGenConfigSchema,
  insideHours,
  type ModelOverride,
  parseHours,
} from "./config.js";
export { GraphBuilder, type Link, saveNodes } from "./graph.js";
export {
  ANIMA,
  BUILTIN_MODELS,
  type BuildOptions,
  buildModelGraph,
  KREA2,
  type LatentNode,
  MOSS_IMAGE,
  type ModelAdapter,
  type ModelFiles,
  snap,
  type Variant,
  variantFiles,
} from "./models.js";
export { ImageGenModule } from "./module.js";
export { ImageGenError, ImageGenService, type ImageGenServiceOptions } from "./service.js";
export { JobStore } from "./store.js";
export {
  detectParams,
  fillWorkflow,
  parseWorkflow,
  type Workflow,
  WorkflowError,
  type WorkflowParam,
} from "./workflow.js";
