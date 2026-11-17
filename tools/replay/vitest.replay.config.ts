// `pnpm replay <file>`: only the file runner, with room for a long log.
import { nodeProject } from "../../vitest.shared.ts";

export default nodeProject({
  test: { include: ["test/run-file.replay.ts"], testTimeout: 30 * 60_000 },
});
