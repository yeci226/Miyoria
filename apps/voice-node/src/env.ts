// Loads a `.env` next to package.json into the environment, if there is one. What the
// environment already sets wins. Imported for its effect, before anything reads a setting.
import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
