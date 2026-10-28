import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CSV_BYTES = 64 * 1024;
const ENV_NAMES = ["INSPIRATION_ENABLED", "DASHSCOPE_API_KEY", "DASHSCOPE_OPENAI_BASE_URL", "DASHSCOPE_NATIVE_BASE_URL", "DASHSCOPE_WORKSPACE_ID"] as const;
type InspirationConfig = Record<(typeof ENV_NAMES)[number], string>;
const invalid = () => new Error("Invalid configuration");

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else {
        if (char === "\n" || char === "\r") throw invalid();
        cell += char;
      }
    } else if (char === "," || char === "\n" || char === "\r") {
      row.push(cell); cell = ""; closed = false;
      if (char !== ",") {
        if (char === "\r" && text[index + 1] === "\n") index++;
        rows.push(row); row = [];
      }
    } else if (char === '"' && cell === "" && !closed) { quoted = true; }
    else {
      if (closed || char === '"') throw invalid();
      cell += char;
    }
  }
  if (quoted) throw invalid();
  if (row.length || cell || closed) { row.push(cell); rows.push(row); }
  return rows;
}

// The runtime's validator lives behind server-only. Enforce its host/workspace
// contract here too, with exact export paths and no port or URL normalization.
function providerUrl(value: string, expectedPath: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    /[?#@\\\s]/.test(value) ||
    !(url.hostname === "maas.aliyuncs.com" || url.hostname.endsWith(".maas.aliyuncs.com")) ||
    !/^[a-z0-9.-]+$/.test(url.hostname) ||
    ![expectedPath, `${expectedPath}/`].includes(url.pathname) ||
    ![`${url.origin}${expectedPath}`, `${url.origin}${expectedPath}/`].includes(value)
  ) throw invalid();
  return url;
}

export function parseInspirationConfigCsv(csv: string): InspirationConfig {
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) throw invalid();
  const labels = new Set(["id", "apiKey", "openAiCompatible", "dashScope", "workspaceId"]);
  const rows = new Map<string, string>();
  for (const row of csvRows(csv)) {
    const [label, value] = row;
    if (row.length !== 2 || !label || rows.has(label) || !value?.trim() || /[\x00-\x1f\x7f$\\]/.test(value)) throw invalid();
    rows.set(label, value);
  }
  if ([...labels].some((label) => !rows.has(label))) throw invalid();
  const openai = providerUrl(rows.get("openAiCompatible")!, "/compatible-mode/v1");
  const native = providerUrl(rows.get("dashScope")!, "/api/v1");
  const workspace = rows.get("workspaceId")!;
  if (openai.hostname !== native.hostname || openai.hostname.split(".")[0] !== workspace) throw invalid();
  return {
    INSPIRATION_ENABLED: "true", DASHSCOPE_API_KEY: rows.get("apiKey")!,
    DASHSCOPE_OPENAI_BASE_URL: rows.get("openAiCompatible")!,
    DASHSCOPE_NATIVE_BASE_URL: rows.get("dashScope")!, DASHSCOPE_WORKSPACE_ID: workspace,
  };
}

function envValue(value: string) {
  if (/[\x00-\x1f\x7f$\\]/.test(value)) throw invalid();
  if (!/[\s#'"`]/.test(value)) return value;
  for (const quote of ['"', "'", "`"]) if (!value.includes(quote)) return `${quote}${value}${quote}`;
  throw invalid();
}

export function upsertEnv(existing: string, values: InspirationConfig): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const pending = new Set<string>(ENV_NAMES);
  const lines = existing.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  let result = "";
  for (let index = 0; index < lines.length; index++) {
    let block = lines[index]!;
    const assignment = block.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*([^\r\n]*)/);
    const value = assignment?.[2] ?? "";
    const quote = ['"', "'", "`"].includes(value[0] ?? "") ? value[0]! : undefined;
    if (quote) {
      // Treat multiline assignments as one block, so their contents cannot be
      // mistaken for independent settings that should be replaced.
      const closed = () => new RegExp(`(?<!\\\\)${quote}`).test(block.slice(block.indexOf(quote) + 1));
      while (!closed() && index + 1 < lines.length) block += lines[++index]!;
    }
    const name = assignment?.[1];
    if (name && ENV_NAMES.includes(name as (typeof ENV_NAMES)[number])) {
      if (pending.delete(name)) result += `${name}=${envValue(values[name as keyof InspirationConfig])}${newline}`;
    } else result += block;
  }
  if (pending.size && result && !/[\r\n]$/.test(result)) result += newline;
  for (const name of ENV_NAMES) if (pending.has(name)) result += `${name}=${envValue(values[name])}${newline}`;
  return result;
}

async function readCsv(filename: string) {
  const file = await open(filename, "r");
  try {
    if (!(await file.stat()).isFile()) throw invalid();
    const buffer = Buffer.alloc(MAX_CSV_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_CSV_BYTES) throw invalid();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

async function writeConfig(values: InspirationConfig) {
  const directory = process.cwd();
  const directoryStat = await stat(directory);
  // A shared writable directory cannot guarantee the no-follow check/rename boundary.
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o022) !== 0 || (process.getuid && directoryStat.uid !== process.getuid())) throw invalid();
  const target = path.join(directory, ".env.local");
  let previous = "";
  try {
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw invalid();
      previous = await file.readFile("utf8");
    } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid();
  }
  const temporary = path.join(directory, `.env.local.${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(upsertEnv(previous, values)); await file.sync(); } finally { await file.close(); }
    try { if ((await lstat(target)).isSymbolicLink()) throw invalid(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid(); }
    await rename(temporary, target);
    created = false;
  } finally { if (created) await unlink(temporary).catch(() => undefined); }
}

async function main() {
  if (process.argv.length !== 3) { console.error("Configuration usage error"); process.exitCode = 1; return; }
  let values: InspirationConfig;
  try { values = parseInspirationConfigCsv(await readCsv(process.argv[2]!)); }
  catch { console.error("Configuration input error"); process.exitCode = 1; return; }
  try { await writeConfig(values); }
  catch { console.error("Configuration write error"); process.exitCode = 1; return; }
  console.log("Configured INSPIRATION_ENABLED and DASHSCOPE_* in .env.local");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error("Configuration write error"); process.exitCode = 1; });
}
