/**
 * Format on Write Extension
 *
 * Overrides built-in `edit` and `write` so touched files are normalized
 * automatically after each mutation.
 *
 * Rules:
 * - `.c` and `.h` use `clang-format` from PATH
 * - Prettier-supported files use `prettier` from PATH
 * - Files not handled by either formatter get safe `.editorconfig` whitespace normalization only
 * - Formatter failures fall back to raw/editorconfig output instead of breaking tool calls
 *
 * `.editorconfig` does NOT post-process files already handled by clang-format or
 * Prettier. It only applies to non-auto-formatted files, and only for safe
 * whitespace rules (`trim_trailing_whitespace`, `insert_final_newline`,
 * `end_of_line`) so extension does not silently break syntax-sensitive files.
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
import { dirname, join, resolve } from "node:path";
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const C_EXTENSIONS = new Set([".c", ".h"]);
const CLANG_FORMAT_CONFIG_FILES = [".clang-format", "_clang-format"];
const FORMATTER_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

const toolCallContext = new AsyncLocalStorage<{ toolCallId: string }>();
const formatResults = new Map<string, FormatOutcome>();
const prettierSupportCache = new Map<string, Promise<PrettierSupport>>();

function clearFormattingState(): void {
  formatResults.clear();
  prettierSupportCache.clear();
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

async function findUp(
  startDir: string,
  names: readonly string[],
): Promise<string | undefined> {
  let current = resolve(startDir);
  for (;;) {
    for (const name of names) {
      const candidate = join(current, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
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
        for (let n = from; step > 0 ? n <= to : n >= to; n += step)
          out.push(String(n));
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
      } else out += "[^/]*";
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
        if (value === "space" || value === "tab")
          current.props.indent_style = value;
        break;
      case "indent_size":
        current.props.indent_size = value === "tab" ? "tab" : toNumber(value);
        break;
      case "tab_width":
        current.props.tab_width = toNumber(value);
        break;
      case "end_of_line":
        if (value === "lf" || value === "crlf" || value === "cr")
          current.props.end_of_line = value;
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

async function loadEditorConfig(filePath: string): Promise<EditorConfig> {
  const absolutePath = resolve(filePath);
  const merged: EditorConfig = {};
  const configs: Array<{ path: string; content: string }> = [];
  let current = dirname(absolutePath);

  for (;;) {
    const configPath = join(current, ".editorconfig");
    const content = await readTextIfExists(configPath);
    if (content !== undefined) {
      configs.push({ path: configPath, content });
      const parsed = parseEditorConfigContent(content);
      if (parsed.root) break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  configs.reverse();
  for (const config of configs) {
    const parsed = parseEditorConfigContent(config.content);
    const configDir = resolve(dirname(config.path));
    const relativePath = absolutePath
      .slice(configDir.length + 1)
      .replace(/\\/g, "/");

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
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// clang-format
// ---------------------------------------------------------------------------

function buildClangFallbackStyle(editorConfig: EditorConfig): string {
  const parts = ["BasedOnStyle: LLVM"];
  const indentWidth =
    editorConfig.indent_size === "tab"
      ? editorConfig.tab_width
      : editorConfig.indent_size;
  const tabWidth =
    editorConfig.tab_width ??
    (typeof indentWidth === "number" ? indentWidth : undefined);

  if (editorConfig.indent_style === "tab") parts.push("UseTab: ForIndentation");
  if (editorConfig.indent_style === "space") parts.push("UseTab: Never");
  if (typeof indentWidth === "number")
    parts.push(`IndentWidth: ${indentWidth}`);
  if (typeof tabWidth === "number") parts.push(`TabWidth: ${tabWidth}`);

  return `{${parts.join(", ")}}`;
}

async function formatWithClang(
  filePath: string,
  input: string,
  editorConfig: EditorConfig,
): Promise<{ text: string; source: string }> {
  const configPath = await findUp(dirname(filePath), CLANG_FORMAT_CONFIG_FILES);
  const args = [
    "--assume-filename",
    filePath,
    configPath
      ? "--style=file"
      : `--style=${buildClangFallbackStyle(editorConfig)}`,
  ];
  const result = await runCommand("clang-format", args, input);
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

  // Evict on failure so transient errors don't stick.
  promise.catch(() => prettierSupportCache.delete(absolutePath));

  return promise;
}

async function formatWithPrettier(
  filePath: string,
  input: string,
): Promise<string> {
  const result = await runCommand(
    "prettier",
    ["--stdin-filepath", filePath, "--log-level", "silent"],
    input,
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
): Promise<{ text: string; outcome: FormatOutcome }> {
  const editorConfig = await loadEditorConfig(filePath);

  const applyEditorconfigFallback = (skippedReason?: string) => {
    const result = applyEditorConfigRules(input, editorConfig);
    return {
      text: result.text,
      outcome: {
        changed: result.text !== input,
        editorconfigApplied: result.applied,
        skippedReason,
      },
    };
  };

  if (isCFile(filePath)) {
    try {
      const formatted = await formatWithClang(filePath, input, editorConfig);
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
      return applyEditorconfigFallback(
        `clang-format failed: ${summarizeError(error)}`,
      );
    }
  }

  const support = await prettierSupports(filePath);
  if (support.supported) {
    try {
      const formatted = await formatWithPrettier(filePath, input);
      return {
        text: formatted,
        outcome: {
          changed: formatted !== input,
          formatter: "prettier",
          editorconfigApplied: false,
        },
      };
    } catch (error) {
      return applyEditorconfigFallback(
        `prettier failed: ${summarizeError(error)}`,
      );
    }
  }

  return applyEditorconfigFallback(support.skippedReason);
}

function splitBom(text: string): { bom: string; text: string } {
  if (text.startsWith("\uFEFF")) {
    return { bom: "\uFEFF", text: text.slice(1) };
  }
  return { bom: "", text };
}

async function formatFileInPlace(filePath: string): Promise<FormatOutcome> {
  const rawBefore = await readFile(filePath, "utf8");
  const { bom, text: before } = splitBom(rawBefore);
  const result = await formatText(filePath, before);
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
  await writeFile(filePath, content, "utf8");
  const outcome = await formatFileInPlace(filePath);
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
  if (outcome.formatter === "clang-format") {
    parts.push(
      `formatted with clang-format (${outcome.formatterSource ?? "config/defaults"})`,
    );
  } else if (outcome.formatter === "prettier") {
    parts.push("formatted with prettier");
  } else if (outcome.editorconfigApplied) {
    parts.push("applied .editorconfig whitespace rules");
  }

  if (outcome.skippedReason) parts.push(outcome.skippedReason);
  if (parts.length === 0) return text;
  return `${text} ${parts.join("; ")}.`;
}

function updateTextContent(
  content: Array<TextContent | { type: string; text?: string }>,
  outcome: FormatOutcome | undefined,
): Array<TextContent | { type: string; text?: string }> {
  if (!outcome) return content;

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
  pi.on("session_start", () => clearFormattingState());
  pi.on("session_shutdown", () => clearFormattingState());

  const cwd = process.cwd();

  const writeTool = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
      writeFile: (filePath, content) => writeAndFormatFile(filePath, content),
    },
  });

  const editTool = createEditToolDefinition(cwd, {
    operations: {
      access: (filePath) => access(filePath, constants.R_OK | constants.W_OK),
      readFile: (filePath) => readFile(filePath),
      writeFile: (filePath, content) => writeAndFormatFile(filePath, content),
    },
  });

  pi.registerTool({
    ...writeTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return toolCallContext.run({ toolCallId }, () =>
        writeTool.execute(toolCallId, params, signal, onUpdate, ctx),
      );
    },
  });

  pi.registerTool({
    ...editTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return toolCallContext.run({ toolCallId }, () =>
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
