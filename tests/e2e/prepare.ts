import path from "node:path";

import { config as loadDotEnv } from "dotenv";

import { resetAndSeed } from "./global-setup";

loadDotEnv({ path: path.join(process.cwd(), ".env.local") });
await resetAndSeed();
