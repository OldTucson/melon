import { spawn } from "node:child_process";

import "./prepare";
import {
  E2E_IMAGE_SEARCH_STUB_PORT,
  E2E_PORT,
} from "./environment";
import { createImageSearchStub } from "./image-search-stub";

const token = process.env.IMAGE_SEARCH_INTERNAL_TOKEN;
if (!token) throw new Error("E2E_IMAGE_SEARCH_TOKEN_MISSING");

const stub = createImageSearchStub(token);
await new Promise<void>((resolve, reject) => {
  stub.once("error", reject);
  stub.listen(Number(E2E_IMAGE_SEARCH_STUB_PORT), "127.0.0.1", resolve);
});

const next = spawn(
  "npm",
  [
    "run",
    "dev",
    "--",
    "--hostname",
    "127.0.0.1",
    "--port",
    E2E_PORT,
  ],
  { env: process.env, stdio: "inherit" },
);

let stopping = false;
const stop = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  stub.close();
  next.kill(signal);
  setTimeout(() => next.kill("SIGKILL"), 10_000).unref();
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
next.once("error", (error) => {
  stub.close();
  throw error;
});
next.once("exit", (code, signal) => {
  stub.close(() => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
});
