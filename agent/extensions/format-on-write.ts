/**
 * Format on Write Extension
 *
 * Overrides built-in `edit` and `write` so touched files are normalized
 * automatically after each mutation.
 *
 * Rules:
 * - `.c` and `.h` use `clang-format` from PATH
 * - Prettier-supported files use `prettier` from PATH
 * - Files not handled by either formatter get `.editorconfig` whitespace rules only
 * - Formatter failures fall back to raw/editorconfig output instead of breaking tool calls
 *
 * `.editorconfig` does NOT post-process files already handled by clang-format or
 * Prettier. It only applies to non-auto-formatted files.
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
import { createEditTool, createWriteTool } from "@mariozechner/pi-coding-agent";

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

const C_EXTENSIONS = new Set([".c", ".h"]);
const CLANG_FORMAT_CONFIG_FILES = [".clang-format", "_clang-format"];
const toolCallContext = new AsyncLocalStorage<{ toolCallId: string }>();
const formatResults = new Map<string, FormatOutcome>();
type PrettierSupport = { supported: boolean; skippedReason?: string };

const prettierSupportCache = new Map<string, Promise<PrettierSupport>>();

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

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "unknown error"
  );
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

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
      default:
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

async function runCommand(
  command: string,
  args: string[],
  input?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
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

async function prettierSupports(filePath: string): Promise<PrettierSupport> {
  const absolutePath = resolve(filePath);
  const cached = prettierSupportCache.get(absolutePath);
  if (cached) return cached;

  const promise = (async () => {
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
  })().catch((error) => {
    prettierSupportCache.delete(absolutePath);
    throw error;
  });

  prettierSupportCache.set(absolutePath, promise);
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

function applyEditorConfigRules(
  text: string,
  config: EditorConfig,
): { text: string; applied: boolean } {
  let next = text;
  let applied = false;

  if (config.trim_trailing_whitespace === true) {
    next = next.replace(/[ \t]+$/gm, "");
    applied = true;
  }

  if (config.end_of_line) {
    next = applyLineEnding(next, config.end_of_line);
    applied = true;
  }

  if (
    config.insert_final_newline === true &&
    next.length > 0 &&
    !next.endsWith("\n") &&
    !next.endsWith("\r")
  ) {
    next +=
      config.end_of_line === "crlf"
        ? "\r\n"
        : config.end_of_line === "cr"
          ? "\r"
          : "\n";
    applied = true;
  }

  return { text: next, applied };
}

async function formatText(
  filePath: string,
  input: string,
): Promise<{ text: string; outcome: FormatOutcome }> {
  const editorConfig = await loadEditorConfig(filePath);

  const applyEditorconfigFallback = (skippedReason?: string) => {
    const editorconfigResult = applyEditorConfigRules(input, editorConfig);
    return {
      text: editorconfigResult.text,
      outcome: {
        changed: editorconfigResult.text !== input,
        editorconfigApplied: editorconfigResult.applied,
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

  const prettierSupport = await prettierSupports(filePath);
  if (prettierSupport.supported) {
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

  return applyEditorconfigFallback(prettierSupport.skippedReason);
}

async function formatFileInPlace(filePath: string): Promise<FormatOutcome> {
  const before = await readFile(filePath, "utf8");
  const result = await formatText(filePath, before);
  if (result.text !== before) {
    await writeFile(filePath, result.text, "utf8");
  }
  return result.outcome;
}

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
    parts.push("formatted with prettier from PATH");
  } else if (outcome.editorconfigApplied) {
    parts.push("applied .editorconfig whitespace rules");
  }

  if (outcome.skippedReason) {
    parts.push(outcome.skippedReason);
  }

  if (parts.length === 0) return text;
  return `${text} ${parts.join("; ")}.`;
}

function updateTextContent(
  content: (TextContent | { type: string; text?: string })[],
  outcome: FormatOutcome | undefined,
) {
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
      type: "text",
      text: appendFormattingNote("Formatting applied", outcome),
    });
  }

  return next;
}

export default function formatOnWriteExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  const writeTool = createWriteTool(cwd, {
    operations: {
      mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => {}),
      async writeFile(filePath, content) {
        await writeAndFormatFile(filePath, content);
      },
    },
  });

  const editTool = createEditTool(cwd, {
    operations: {
      access: (filePath) => access(filePath, constants.R_OK | constants.W_OK),
      readFile: (filePath) => readFile(filePath),
      async writeFile(filePath, content) {
        await writeAndFormatFile(filePath, content);
      },
    },
  });

  pi.registerTool({
    name: "write",
    label: "write",
    description: writeTool.description,
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: writeTool.parameters,
    async execute(toolCallId, params, signal, onUpdate) {
      return toolCallContext.run({ toolCallId }, () =>
        writeTool.execute(toolCallId, params, signal, onUpdate),
      );
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: editTool.description,
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use edit for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
    parameters: editTool.parameters,
    renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate) {
      return toolCallContext.run({ toolCallId }, () =>
        editTool.execute(toolCallId, params, signal, onUpdate),
      );
    },
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "edit" && event.toolName !== "write")
      return undefined;

    const outcome = formatResults.get(event.toolCallId);
    formatResults.delete(event.toolCallId);

    if (event.isError) return undefined;
    return { content: updateTextContent(event.content, outcome) };
  });
}
