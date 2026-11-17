import { nodeProject } from "../../vitest.shared.ts";

// The first prompt or `config set` of a test file loads the root config schema, which imports
// every module package from source: that alone can take longer than the default 5 s.
export default nodeProject({ test: { testTimeout: 30_000 } });
