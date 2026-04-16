/**
 * Format on Write Extension
 *
 * Overrides built-in `edit` and `write` so touched files are normalized after
 * each mutation without changing core pi behavior.
 *
 * Rules:
 * - `.c` and `.h` use `clang-format` from PATH
 *   - if `.clang-format`/`_clang-format` exists, use it
 *   - otherwise use deterministic fallback style (`LLVM`)
 * - Prettier-supported files use `prettier` from PATH
 *   - honors normal Prettier config and EditorConfig resolution
 *   - intentionally ignores `.prettierignore` so touched supported files are
 *     always formatted
 * - Files not handled by either formatter get safe `.editorconfig` whitespace
 *   normalization only
 * - Formatter failures never break `edit` / `write`
 *
 * `.editorconfig` fallback only applies to files not handled by clang-format or
 * Prettier, and only for safe whitespace rules:
 * - `trim_trailing_whitespace`
 * - `insert_final_newline`
 * - `end_of_line`
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import {
  access,
  constants,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FormatterName = "clang-format" | "prettier";

type EditorConfig = {
  indent_style?: "space" | "tab";
  indent_size?: number | "tab";
  tab_width?: number;
  end_of_line?: "lf" | "crlf" | "cr";
  trim_trailing_whitespace?: boolean;
  insert_final_newline?: boolean;
};

type FormatOutcome = {
  changed: boolean;
  formatter?: FormatterName;
  formatterSource?: string;
  editorconfigApplied: boolean;
  skippedReason?: string;
};

type PrettierSupport = { supported: boolean; skippedReason?: string };

type ToolCallStore = {
  toolCallId: string;
  cwd: string;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const C_EXTENSIONS = new Set([".c", ".h"]);
const CLANG_FORMAT_CONFIG_FILES = [".clang-format", "_clang-format"];
const FORMATTER_TIMEOUT_MS = 10_000;
const NULL_IGNORE_PATH = "/dev/null";
const FORMAT_ON_WRITE_SENTINEL = Symbol.for("pi.format-on-write.loaded");

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

const toolCallContext = new AsyncLocalStorage<ToolCallStore>();
const formatResults = new Map<string, FormatOutcome>();
const prettierSupportCache = new Map<string, Promise<PrettierSupport>>();

function clearFormattingState(): void {
  formatResults.clear();
  prettierSupportCache.clear();
}

function claimExtensionInstance(): boolean {
  const state = globalThis as typeof globalThis & {
    [FORMAT_ON_WRITE_SENTINEL]?: boolean;
  };
  if (state[FORMAT_ON_WRITE_SENTINEL]) return false;
  state[FORMAT_ON_WRITE_SENTINEL] = true;
  return true;
}

function releaseExtensionInstance(): void {
  const state = globalThis as typeof globalThis & {
    [FORMAT_ON_WRITE_SENTINEL]?: boolean;
  };
  delete state[FORMAT_ON_WRITE_SENTINEL];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getExtension(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}

function isCFile(filePath: string): boolean {
  return C_EXTENSIONS.has(getExtension(filePath));
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith("../") &&
      !rel.startsWith("..\\") &&
      !rel.startsWith("/") &&
      !rel.startsWith("\\"))
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function findUpWithinCwd(
  startDir: string,
  names: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  const root = resolve(cwd);
  let current = resolve(startDir);

  if (!isWithinRoot(root, current)) return undefined;

  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      if (await exists(candidate)) return candidate;
    }
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current || !isWithinRoot(root, parent)) return undefined;
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function applyLineEnding(
  text: string,
  endOfLine: EditorConfig["end_of_line"],
): string {
  const normalized = normalizeLineEndings(text);
  if (endOfLine === "crlf") return normalized.replace(/\n/g, "\r\n");
  if (endOfLine === "cr") return normalized.replace(/\n/g, "\r");
  return normalized;
}

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "unknown error"
  );
}

function splitBom(text: string): { bom: string; text: string } {
  if (text.startsWith("\uFEFF")) {
    return { bom: "\uFEFF", text: text.slice(1) };
  }
  return { bom: "", text };
}

// ---------------------------------------------------------------------------
// EditorConfig parser
// ---------------------------------------------------------------------------

function splitTopLevelComma(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start === -1) return [pattern];

  let depth = 0;
  let end = -1;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [pattern];

  const prefix = pattern.slice(0, start);
  const body = pattern.slice(start + 1, end);
  const suffix = pattern.slice(end + 1);
  const numeric = body.match(/^(-?\d+)\.\.(-?\d+)$/);
  const variants = numeric
    ? (() => {
        const from = Number(numeric[1]);
        const to = Number(numeric[2]);
        const step = from <= to ? 1 : -1;
        const out: string[] = [];
        for (let n = from; step > 0 ? n <= to : n >= to; n += step) {
          out.push(String(n));
        }
        return out;
      })()
    : splitTopLevelComma(body);

  const out: string[] = [];
  for (const variant of variants) {
    for (const expanded of expandBraces(prefix + variant + suffix)) {
      out.push(expanded);
    }
  }
  return out;
}

function escapeRegexChar(ch: string): string {
  return /[|\\{}()[\]^$+?.]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      let j = i + 1;
      if (glob[j] === "!") j++;
      while (j < glob.length && glob[j] !== "]") j++;
      if (j < glob.length) {
        let cls = glob.slice(i + 1, j);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = j;
        continue;
      }
    }
    out += escapeRegexChar(ch);
  }
  return out;
}

function matchEditorConfigSection(
  section: string,
  relativePath: string,
): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  for (const expanded of expandBraces(section)) {
    const source = globToRegexSource(expanded);
    const regex = expanded.includes("/")
      ? new RegExp(`^${source}$`)
      : new RegExp(`^(?:.*/)?${source}$`);
    if (regex.test(normalized)) return true;
  }
  return false;
}

function parseEditorConfigContent(content: string): {
  root: boolean;
  sections: Array<{ pattern: string; props: EditorConfig }>;
} {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ pattern: string; props: EditorConfig }> = [];
  let root = false;
  let current: { pattern: string; props: EditorConfig } | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      current = { pattern: line.slice(1, -1).trim(), props: {} };
      sections.push(current);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line
      .slice(eq + 1)
      .trim()
      .toLowerCase();

    if (!current) {
      if (key === "root") root = value === "true";
      continue;
    }

    switch (key) {
      case "indent_style":
        if (value === "space" || value === "tab") {
          current.props.indent_style = value;
        }
        break;
      case "indent_size":
        current.props.indent_size = value === "tab" ? "tab" : toNumber(value);
        break;
      case "tab_width":
        current.props.tab_width = toNumber(value);
        break;
      case "end_of_line":
        if (value === "lf" || value === "crlf" || value === "cr") {
          current.props.end_of_line = value;
        }
        break;
      case "trim_trailing_whitespace":
        current.props.trim_trailing_whitespace = parseBoolean(value);
        break;
      case "insert_final_newline":
        current.props.insert_final_newline = parseBoolean(value);
        break;
    }
  }

  return { root, sections };
}

async function loadEditorConfig(
  filePath: string,
  cwd: string,
): Promise<EditorConfig> {
  const absolutePath = resolve(filePath);
  const root = resolve(cwd);
  if (!isWithinRoot(root, absolutePath)) return {};

  const merged: EditorConfig = {};
  const configs: Array<{ path: string; content: string }> = [];
  let current = dirname(absolutePath);

  for (;;) {
    const configPath = join(current, ".editorconfig");
    const content = await readTextIfExists(configPath);
    if (content !== undefined) {
      configs.push({ path: configPath, content });
      if (parseEditorConfigContent(content).root) break;
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current || !isWithinRoot(root, parent)) break;
    current = parent;
  }

  configs.reverse();
  for (const config of configs) {
    const parsed = parseEditorConfigContent(config.content);
    const configDir = resolve(dirname(config.path));
    const relativePath = relative(configDir, absolutePath).replace(/\\/g, "/");

    for (const section of parsed.sections) {
      if (matchEditorConfigSection(section.pattern, relativePath)) {
        Object.assign(merged, section.props);
      }
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

async function runCommand(
  command: string,
  args: string[],
  input?: string,
  timeoutMs: number = FORMATTER_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (
      kind: "resolve" | "reject",
      value: { stdout: string; stderr: string } | Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (kind === "resolve") {
        resolvePromise(value as { stdout: string; stderr: string });
      } else {
        reject(value);
      }
    };

    const stopChild = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 100);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      stopChild();
      finish("reject", new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      stopChild();
      finish("reject", new Error(`${command} aborted`));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish("reject", err);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) {
        finish("resolve", { stdout, stderr });
        return;
      }
      finish(
        "reject",
        new Error(stderr.trim() || `${command} exited with code ${code}`),
      );
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// clang-format
// ---------------------------------------------------------------------------

async function formatWithClang(
  filePath: string,
  input: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ text: string; source: string }> {
  const configPath = await findUpWithinCwd(
    dirname(filePath),
    CLANG_FORMAT_CONFIG_FILES,
    cwd,
  );
  const args = [
    "--assume-filename",
    filePath,
    configPath ? "--style=file" : "--style=LLVM",
  ];
  const result = await runCommand(
    "clang-format",
    args,
    input,
    FORMATTER_TIMEOUT_MS,
    signal,
  );
  return { text: result.stdout, source: configPath ?? "LLVM fallback" };
}

// ---------------------------------------------------------------------------
// Prettier
// ---------------------------------------------------------------------------

async function prettierSupports(filePath: string): Promise<PrettierSupport> {
  const absolutePath = resolve(filePath);
  const cached = prettierSupportCache.get(absolutePath);
  if (cached) return cached;

  const promise = (async (): Promise<PrettierSupport> => {
    try {
      const result = await runCommand("prettier", [
        "--file-info",
        absolutePath,
        "--log-level",
        "silent",
        "--ignore-path",
        NULL_IGNORE_PATH,
      ]);
      const info = JSON.parse(result.stdout) as {
        inferredParser?: string | null;
        ignored?: boolean;
      };
      return {
        supported:
          !info.ignored &&
          typeof info.inferredParser === "string" &&
          info.inferredParser.length > 0,
      };
    } catch (error) {
      return {
        supported: false,
        skippedReason: `prettier unavailable: ${summarizeError(error)}`,
      };
    }
  })();

  prettierSupportCache.set(absolutePath, promise);
  promise.catch(() => prettierSupportCache.delete(absolutePath));
  return promise;
}

async function formatWithPrettier(
  filePath: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runCommand(
    "prettier",
    [
      "--stdin-filepath",
      filePath,
      "--log-level",
      "silent",
      "--ignore-path",
      NULL_IGNORE_PATH,
    ],
    input,
    FORMATTER_TIMEOUT_MS,
    signal,
  );
  return result.stdout;
}

// ---------------------------------------------------------------------------
// EditorConfig application
// ---------------------------------------------------------------------------

function detectExistingLineEnding(
  text: string,
): EditorConfig["end_of_line"] | undefined {
  const firstCrLf = text.indexOf("\r\n");
  if (firstCrLf !== -1) return "crlf";

  const firstCr = text.indexOf("\r");
  if (firstCr !== -1) return "cr";

  const firstLf = text.indexOf("\n");
  if (firstLf !== -1) return "lf";

  return undefined;
}

function applyEditorConfigRules(
  text: string,
  config: EditorConfig,
): { text: string; applied: boolean } {
  let next = text;
  let applied = false;

  if (config.trim_trailing_whitespace === true) {
    const trimmed = next.replace(/[ \t]+$/gm, "");
    applied = applied || trimmed !== next;
    next = trimmed;
  }

  const targetLineEnding = config.end_of_line ?? detectExistingLineEnding(next);
  if (targetLineEnding) {
    const withLineEndings = applyLineEnding(next, targetLineEnding);
    applied = applied || withLineEndings !== next;
    next = withLineEndings;
  }

  if (
    config.insert_final_newline === true &&
    !next.endsWith("\n") &&
    !next.endsWith("\r")
  ) {
    next +=
      targetLineEnding === "crlf"
        ? "\r\n"
        : targetLineEnding === "cr"
          ? "\r"
          : "\n";
    applied = true;
  }

  return { text: next, applied };
}

// ---------------------------------------------------------------------------
// Core formatting pipeline
// ---------------------------------------------------------------------------

async function formatText(
  filePath: string,
  input: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ text: string; outcome: FormatOutcome }> {
  if (isCFile(filePath)) {
    try {
      const formatted = await formatWithClang(filePath, input, cwd, signal);
      return {
        text: formatted.text,
        outcome: {
          changed: formatted.text !== input,
          formatter: "clang-format",
          formatterSource: formatted.source,
          editorconfigApplied: false,
        },
      };
    } catch (error) {
      return {
        text: input,
        outcome: {
          changed: false,
          editorconfigApplied: false,
          skippedReason: `clang-format failed: ${summarizeError(error)}`,
        },
      };
    }
  }

  const support = await prettierSupports(filePath);
  if (support.supported) {
    try {
      const formatted = await formatWithPrettier(filePath, input, signal);
      return {
        text: formatted,
        outcome: {
          changed: formatted !== input,
          formatter: "prettier",
          editorconfigApplied: false,
        },
      };
    } catch (error) {
      return {
        text: input,
        outcome: {
          changed: false,
          editorconfigApplied: false,
          skippedReason: `prettier failed: ${summarizeError(error)}`,
        },
      };
    }
  }

  const editorConfig = await loadEditorConfig(filePath, cwd);
  const result = applyEditorConfigRules(input, editorConfig);
  return {
    text: result.text,
    outcome: {
      changed: result.text !== input,
      editorconfigApplied: result.applied,
      skippedReason: support.skippedReason,
    },
  };
}

async function formatFileInPlace(
  filePath: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<FormatOutcome> {
  const rawBefore = await readFile(filePath, "utf8");
  const { bom, text: before } = splitBom(rawBefore);
  const result = await formatText(filePath, before, cwd, signal);
  const rawAfter = bom + result.text;
  if (rawAfter !== rawBefore) {
    await writeFile(filePath, rawAfter, "utf8");
  }
  return result.outcome;
}

// ---------------------------------------------------------------------------
// Tool call / result correlation
// ---------------------------------------------------------------------------

function storeFormatOutcome(outcome: FormatOutcome): void {
  const store = toolCallContext.getStore();
  if (store) formatResults.set(store.toolCallId, outcome);
}

async function writeAndFormatFile(
  filePath: string,
  content: string,
): Promise<void> {
  const store = toolCallContext.getStore();
  await writeFile(filePath, content, "utf8");
  const outcome = await formatFileInPlace(
    filePath,
    store?.cwd ?? process.cwd(),
    store?.signal,
  );
  storeFormatOutcome(outcome);
}

// ---------------------------------------------------------------------------
// Result annotation
// ---------------------------------------------------------------------------

function appendFormattingNote(
  text: string,
  outcome: FormatOutcome | undefined,
): string {
  if (!outcome) return text;

  const parts: string[] = [];
  if (outcome.skippedReason) {
    parts.push(outcome.skippedReason);
  }

  if (outcome.changed || outcome.editorconfigApplied) {
    if (outcome.formatter === "clang-format") {
      parts.unshift(
        `formatted with clang-format (${outcome.formatterSource ?? "config/defaults"})`,
      );
    } else if (outcome.formatter === "prettier") {
      parts.unshift("formatted with prettier");
    } else if (outcome.editorconfigApplied) {
      parts.unshift("applied .editorconfig whitespace rules");
    }
  }

  if (parts.length === 0) return text;
  return `${text} ${parts.join("; ")}.`;
}

function updateTextContent(
  content: Array<TextContent | { type: string; text?: string }>,
  outcome: FormatOutcome | undefined,
): Array<TextContent | { type: string; text?: string }> {
  if (!outcome) return content;

  const noteNeeded =
    outcome.changed ||
    outcome.editorconfigApplied ||
    Boolean(outcome.skippedReason);
  if (!noteNeeded) return content;

  let replaced = false;
  const next = content.map((block) => {
    if (!replaced && block.type === "text") {
      replaced = true;
      return {
        ...block,
        text: appendFormattingNote(block.text ?? "", outcome),
      };
    }
    return block;
  });

  if (!replaced) {
    next.push({
      type: "text" as const,
      text: appendFormattingNote("Formatting applied", outcome),
    });
  }

  return next;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function formatOnWriteExtension(pi: ExtensionAPI): void {
  if (!claimExtensionInstance()) return;

  pi.on("session_start", () => clearFormattingState());
  pi.on("session_shutdown", () => {
    clearFormattingState();
    releaseExtensionInstance();
  });

  const extensionCwd = process.cwd();

  const writeTool = createWriteToolDefinition(extensionCwd, {
    operations: {
      mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
      writeFile: (filePath, content) => writeAndFormatFile(filePath, content),
    },
  });

  const editTool = createEditToolDefinition(extensionCwd, {
    operations: {
      access: (filePath) => access(filePath, constants.R_OK | constants.W_OK),
      readFile: (filePath) => readFile(filePath),
      writeFile: (filePath, content) => writeAndFormatFile(filePath, content),
    },
  });

  pi.registerTool({
    ...writeTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return toolCallContext.run({ toolCallId, cwd: ctx.cwd, signal }, () =>
        writeTool.execute(toolCallId, params, signal, onUpdate, ctx),
      );
    },
  });

  pi.registerTool({
    ...editTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return toolCallContext.run({ toolCallId, cwd: ctx.cwd, signal }, () =>
        editTool.execute(toolCallId, params, signal, onUpdate, ctx),
      );
    },
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;

    const outcome = formatResults.get(event.toolCallId);
    formatResults.delete(event.toolCallId);

    if (event.isError || !outcome) return;
    return { content: updateTextContent(event.content, outcome) };
  });
}
