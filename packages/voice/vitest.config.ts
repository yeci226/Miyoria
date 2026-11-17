import { nodeProject } from "../../vitest.shared.ts";

// One folder per part of the package, each with its own src/ and test/.
export default nodeProject({
  test: { include: ["*/test/**/*.test.ts", "*/src/**/*.test.ts"] },
});
