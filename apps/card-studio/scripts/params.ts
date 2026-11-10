// Lists the model's parameters with their ranges: `tsx scripts/params.ts [modelDir]`.
import { CardStudio } from "../src/render.js";

const modelDir =
  process.argv[2] ??
  "C:/Program Files (x86)/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels/DeepSeek-chan";
const studio = new CardStudio({ modelDir });
try {
  for (const p of await studio.parameters(encodeURIComponent("大肥鱼.model3.json"))) {
    console.log(`${p.id}\t${p.min}\t${p.max}\t${p.default}`);
  }
} finally {
  await studio.stop();
}
