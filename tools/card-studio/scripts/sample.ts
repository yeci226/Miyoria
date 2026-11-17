// Renders sample cards to a folder: `pnpm --filter @miyoria/card-studio sample <out> [modelDir]`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStudio, type PoseSpec } from "../src/render.js";

const out = process.argv[2] ?? "samples";
const modelDir =
  process.argv[3] ??
  "C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels/DeepSeek-chan";
mkdirSync(out, { recursive: true });
const studio = new CardStudio({ modelDir });
const base: Omit<PoseSpec, "model"> = {
  set: {},
  add: {},
  width: 800,
  height: 1100,
  zoom: 1,
  centerX: 0,
  centerY: 0,
  settle: 2,
};
const samples: Record<string, Partial<PoseSpec>> = JSON.parse(
  process.env.SAMPLES_FILE
    ? readFileSync(process.env.SAMPLES_FILE, "utf8")
    : (process.env.SAMPLES ?? '{"whole":{}}'),
);
try {
  for (const [name, s] of Object.entries(samples)) {
    const t = Date.now();
    const png = await studio.render({
      ...base,
      ...s,
      model: encodeURIComponent("大肥鱼.model3.json"),
    });
    writeFileSync(join(out, `${name}.png`), png);
    console.log(name, png.length, `${Date.now() - t} ms`);
  }
} finally {
  await studio.stop();
}
