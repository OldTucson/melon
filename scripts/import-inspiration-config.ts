import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotEnv } from "dotenv";

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

type EnvBlock = { text: string; name?: string };

function sameEnv(left: Record<string, string>, right: Record<string, string>) {
  const names = Object.keys(left);
  return names.length === Object.keys(right).length &&
    names.every((name) => Object.hasOwn(right, name) && left[name] === right[name]);
}

function envBlocks(existing: string): EnvBlock[] {
  const lines = existing.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
  const blocks: EnvBlock[] = [];
  const semantic: Record<string, string> = Object.create(null);
  const withoutEnding = (line: string) => line.replace(/(?:\r\n|\r|\n)$/, "");
  for (let index = 0; index < lines.length; index++) {
    let text = lines[index]!;
    let content = withoutEnding(text);
    if (/^\s*(?:#.*)?$/.test(content)) { blocks.push({ text }); continue; }
    // Match dotenv's key grammar and its two assignment forms. Horizontal
    // whitespace is deliberate: cross-line assignment syntax is unsupported.
    const assignment = content.match(/^[^\S\r\n]*(?:export[^\S\r\n]+)?([\w.-]+)(?:[^\S\r\n]*=[^\S\r\n]*|:[^\S\r\n]+)([^\r\n]*)$/);
    if (!assignment) throw invalid();
    const name = assignment[1]!, value = assignment[2]!;
    const quote = ['"', "'", "`"].includes(value[0] ?? "") ? value[0] : undefined;
    if (quote) {
      let offset = content.length - value.length + 1, closed = false;
      while (!closed) {
        let backslashes = 0;
        for (let cursor = offset; cursor < content.length; cursor++) {
          const char = content[cursor]!;
          if (char === quote && backslashes % 2 === 0) {
            if (!/^[^\S\r\n]*(?:#.*)?$/.test(content.slice(cursor + 1))) throw invalid();
            closed = true;
            break;
          }
          backslashes = char === "\\" ? backslashes + 1 : 0;
        }
        if (!closed) {
          if (++index >= lines.length) throw invalid();
          const next = lines[index]!;
          text += next;
          content = withoutEnding(next);
          offset = 0;
        }
      }
    }
    // Let the installed dependency own value semantics. A block must parse as
    // exactly its lexical assignment, and the complete file must agree too.
    const parsed = parseDotEnv(text);
    if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, name)) throw invalid();
    semantic[name] = parsed[name]!;
    blocks.push({ text, name });
  }
  if (!sameEnv(semantic, parseDotEnv(existing))) throw invalid();
  return blocks;
}

function nextExpansionReferences(value: string): Set<string> {
  const references = new Set<string>();
  let defaults = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "}" && defaults > 0) { defaults--; continue; }
    // Installed @next/env treats any immediately preceding backslash as an
    // escape, rather than applying shell-style backslash parity to dollars.
    if (char !== "$" || value[index - 1] === "\\") {
      if (defaults && (char === "{" || char === "\\")) throw invalid();
      continue;
    }
    const braced = value[index + 1] === "{";
    const start = index + (braced ? 2 : 1);
    const name = value.slice(start).match(/^\w+/)?.[0];
    if (!name) throw invalid();
    references.add(name);
    index = start + name.length - 1;
    if (braced) {
      if (value[index + 1] === "}") index++;
      else if (value.slice(index + 1, index + 3) === ":-") { defaults++; index += 2; }
      else throw invalid();
    }
  }
  if (defaults) throw invalid();
  return references;
}

function assertBoundedEnvValue(value: string) {
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw invalid();
}

function assertNoUnsafeExpansion(parsed: Record<string, string>) {
  const targets = new Set<string>(ENV_NAMES);
  const reverse = new Map<string, Set<string>>();
  const degree = new Map<string, number>();
  for (const [name, value] of Object.entries(parsed)) {
    assertBoundedEnvValue(value);
    const dependencies = nextExpansionReferences(value);
    // A future build's ambient env may override even a harmless/missing alias.
    // Reject all active non-target interpolation, independently of this file's
    // dependency values. Escaped literals cannot be reactivated by accepted refs.
    if (!targets.has(name) && dependencies.size > 0) throw invalid();
    let count = 0;
    for (const dependency of dependencies) {
      const dependents = reverse.get(dependency) ?? new Set<string>();
      dependents.add(name);
      reverse.set(dependency, dependents);
      if (Object.hasOwn(parsed, dependency)) count++;
    }
    degree.set(name, count);
  }
  // Iterative topological traversal rejects cycles without recursive overflow.
  const ready = [...degree].filter(([, count]) => count === 0).map(([name]) => name);
  for (let index = 0; index < ready.length; index++) {
    for (const dependent of reverse.get(ready[index]!) ?? []) {
      const count = degree.get(dependent)! - 1;
      degree.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (ready.length !== degree.size) throw invalid();

  const tainted = new Set<string>(ENV_NAMES), pending: string[] = [...ENV_NAMES];
  for (let index = 0; index < pending.length; index++) {
    for (const dependent of reverse.get(pending[index]!) ?? []) {
      if (!targets.has(dependent)) throw invalid();
      if (!tainted.has(dependent)) { tainted.add(dependent); pending.push(dependent); }
    }
  }

  // Next recursively interpolates substituted text, so references can also be
  // assembled ("${PREFIX}API_KEY") or activated through a previously unescaped
  // alias. Check those order-sensitive cases using pure, bounded symbolic values.
  // Never pass local values to @next/env or mutate ambient process.env here.
  const symbolic = new Map(Object.entries(parsed));
  for (const name of ENV_NAMES) symbolic.set(name, `\0inspiration:${name}\0`);
  let remaining = 10_000;
  for (const [name, original] of symbolic) {
    let value = original;
    while (true) {
      assertBoundedEnvValue(value);
      let dollar = value.length - 1;
      while (dollar >= 0 && (value[dollar] !== "$" || value[dollar - 1] === "\\")) dollar--;
      if (dollar < 0) break;
      if (--remaining < 0) throw invalid();
      // This is the installed Next interpolation token grammar. Unsupported
      // original syntax has already been rejected by the dependency scanner.
      const token = value.slice(dollar).match(/^\$\{?(\w+)(?::-([^}\\]*))?}?/);
      if (!token) throw invalid();
      const dependency = token[1]!;
      if (!targets.has(name) && targets.has(dependency)) throw invalid();
      const replacement = token[2] || symbolic.get(dependency) || "";
      value = value.replace(token[0], replacement);
      assertBoundedEnvValue(value);
    }
    const finalValue = value.replace(/\\\$/g, "$");
    assertBoundedEnvValue(finalValue);
    symbolic.set(name, finalValue);
  }
}

export function upsertEnv(existing: string, values: InspirationConfig): string {
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const pending = new Set<string>(ENV_NAMES);
  const blocks = envBlocks(existing);
  assertNoUnsafeExpansion(parseDotEnv(existing));
  let result = "";
  for (const { text, name } of blocks) {
    if (name && ENV_NAMES.includes(name as (typeof ENV_NAMES)[number])) {
      if (pending.delete(name)) result += `${name}=${envValue(values[name as keyof InspirationConfig])}${newline}`;
    } else result += text;
  }
  if (pending.size && result && !/[\r\n]$/.test(result)) result += newline;
  for (const name of ENV_NAMES) if (pending.has(name)) result += `${name}=${envValue(values[name])}${newline}`;

  const before = parseDotEnv(existing), after = parseDotEnv(result);
  const updatedBlocks = envBlocks(result);
  assertNoUnsafeExpansion(after);
  for (const name of ENV_NAMES) {
    if (after[name] !== values[name] || updatedBlocks.filter((block) => block.name === name).length !== 1) throw invalid();
    delete before[name];
    delete after[name];
  }
  if (!sameEnv(before, after)) throw invalid();
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
