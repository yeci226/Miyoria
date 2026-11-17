import { nodeProject } from "../../vitest.shared.ts";

export default nodeProject({ test: { include: ["test/**/*.test.tsx"] } });
