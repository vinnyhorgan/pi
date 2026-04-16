import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type ExtensionAPI,
  type Theme,
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type OutputFormat = "markdown" | "text";

type SearchResult = {
  id: string;
  title: string;
  description: string;
  branch?: string;
  lastUpdateDate?: string;
  state?: string;
  totalTokens?: number;
  totalSnippets?: number;
  stars?: number;
  trustScore?: number;
  benchmarkScore?: number;
  versions?: string[];
};

type SearchResponse = {
  results: SearchResult[];
  searchFilterApplied?: boolean;
};

type CodeSnippet = {
  codeTitle: string;
  codeDescription?: string;
  codeLanguage?: string;
  codeTokens?: number;
  codeId?: string;
  pageTitle?: string;
  codeList?: Array<{
    language?: string;
    code: string;
  }>;
};

type InfoSnippet = {
  pageId?: string;
  breadcrumb?: string;
  content: string;
  contentTokens?: number;
};

type ContextRules =
  | string[]
  | Array<{
      title?: string;
      description?: string;
      rule?: string;
      content?: string;
    }>;

type ContextResponse = {
  codeSnippets: CodeSnippet[];
  infoSnippets: InfoSnippet[];
  rules?: ContextRules;
  libraryId?: string;
};

interface ToolMeta {
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

interface LibrarySearchDetails extends ToolMeta {
  libraryName: string;
  query: string;
  resultCount: number;
  returnedCount: number;
  searchFilterApplied: boolean;
}

interface LibraryDocsDetails extends ToolMeta {
  libraryId: string;
  query: string;
  codeSnippetCount: number;
  infoSnippetCount: number;
  rulesCount: number;
  format: OutputFormat;
}

const HIDDEN_COMPONENT: Component = {
  render() {
    return [];
  },
  invalidate() {},
};

const LibrarySearchParams = Type.Object({
  library_name: Type.String({
    description: "Library or framework name to match",
  }),
  query: Type.String({
    description: "What docs or examples you need. Used to rank matches.",
  }),
  max_results: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description: "Maximum matches to return after ranking",
    }),
  ),
});

const LibraryDocsParams = Type.Object({
  library_id: Type.String({
    description:
      "Exact library ID from library_search or direct ID like /vercel/next.js",
  }),
  query: Type.String({
    description: "What docs, setup steps, or examples you need",
  }),
  version: Type.Optional(
    Type.String({
      description:
        "Optional version tag to pin when library_id does not already include one",
    }),
  ),
  tokens: Type.Optional(
    Type.Number({
      minimum: 100,
      maximum: 100000,
      description: "Approximate maximum token budget for returned docs",
    }),
  ),
  format: Type.Optional(
    StringEnum(["markdown", "text"] as const, {
      description: "How tool should format returned snippets",
    }),
  ),
});

function getApiKey(): string | undefined {
  const value = process.env.CONTEXT7_API_KEY?.trim();
  return value ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLibraryId(value: unknown): string | undefined {
  const raw = normalizeString(value);
  if (!raw) return undefined;

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const url = new URL(raw);
      const path = url.pathname.replace(/\/+$/, "");
      if (path && !path.startsWith("/docs")) return path;
    } catch {}
  }

  if (raw.startsWith("/")) return raw;
  if (raw.includes("/") && !raw.includes(" ")) return `/${raw}`;
  return raw;
}

function mergeLibraryVersion(
  libraryId: string,
  version: string | undefined,
): string {
  const normalizedVersion = normalizeString(version);
  if (!normalizedVersion) return libraryId;
  if (libraryId.includes("@")) return libraryId;
  const segments = libraryId.split("/").filter(Boolean);
  if (segments.length >= 3) return libraryId;
  return `${libraryId}@${normalizedVersion}`;
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return 10;
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function trustLabel(score: number | undefined): string {
  if (score === undefined || score < 0) return "unknown";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function formatNumber(value: number | undefined): string | undefined {
  return value === undefined ? undefined : value.toLocaleString();
}

function formatScore(
  value: number | undefined,
  suffix: string,
): string | undefined {
  return value === undefined ? undefined : `${value}${suffix}`;
}

function formatSearchResult(result: SearchResult, index: number): string[] {
  const lines = [
    `${index + 1}. ${result.title}`,
    `Library ID: ${result.id}`,
    `Trust: ${formatScore(result.trustScore, "/10") ?? "unknown"} (${trustLabel(result.trustScore)})`,
  ];

  const benchmark = formatScore(result.benchmarkScore, "/100");
  if (benchmark) lines.push(`Quality: ${benchmark}`);
  const snippets = formatNumber(result.totalSnippets);
  if (snippets) lines.push(`Snippets: ${snippets}`);
  const tokens = formatNumber(result.totalTokens);
  if (tokens) lines.push(`Tokens: ${tokens}`);
  if (result.branch) lines.push(`Branch: ${result.branch}`);
  if (result.state) lines.push(`State: ${result.state}`);
  if (result.lastUpdateDate) lines.push(`Updated: ${result.lastUpdateDate}`);
  if (result.stars !== undefined && result.stars >= 0)
    lines.push(`Stars: ${result.stars.toLocaleString()}`);
  lines.push(`Description: ${result.description}`);
  if (result.versions && result.versions.length > 0) {
    lines.push("Versions:");
    for (const version of result.versions.slice(0, 20))
      lines.push(`- ${version}`);
    if (result.versions.length > 20)
      lines.push(`- ... ${result.versions.length - 20} more`);
  }

  return lines;
}

function formatRules(rules: ContextRules | undefined): string[] {
  if (!rules || !Array.isArray(rules) || rules.length === 0) return [];

  const lines = ["Library guidance:"];
  for (const rule of rules) {
    if (typeof rule === "string") {
      lines.push(`- ${rule}`);
      continue;
    }
    const title = normalizeString(rule.title);
    const content =
      normalizeString(rule.rule) ??
      normalizeString(rule.content) ??
      normalizeString(rule.description);
    if (title && content) lines.push(`- ${title}: ${content}`);
    else if (title) lines.push(`- ${title}`);
    else if (content) lines.push(`- ${content}`);
  }
  return lines.length > 1 ? lines : [];
}

function formatContextText(
  response: ContextResponse,
  libraryId: string,
  query: string,
  format: OutputFormat,
): string {
  const lines: string[] = [`Library: ${libraryId}`, `Question: ${query}`];

  const ruleLines = formatRules(response.rules);
  if (ruleLines.length > 0) lines.push("", ...ruleLines);

  if (response.codeSnippets.length > 0) {
    lines.push("", `Code snippets (${response.codeSnippets.length}):`);
    for (const [index, snippet] of response.codeSnippets.entries()) {
      lines.push("", `${index + 1}. ${snippet.codeTitle}`);
      if (snippet.pageTitle && snippet.pageTitle !== "Unknown")
        lines.push(`Page: ${snippet.pageTitle}`);
      if (snippet.codeDescription) lines.push(snippet.codeDescription);
      if (snippet.codeId) lines.push(`Source: ${snippet.codeId}`);
      for (const code of snippet.codeList ?? []) {
        if (format === "markdown") {
          lines.push(
            "",
            `\`\`\`${normalizeString(code.language) ?? normalizeString(snippet.codeLanguage) ?? "text"}`,
            code.code,
            "\`\`\`",
          );
        } else {
          const language =
            normalizeString(code.language) ??
            normalizeString(snippet.codeLanguage);
          if (language) lines.push(`Language: ${language}`);
          lines.push(code.code);
        }
      }
    }
  }

  if (response.infoSnippets.length > 0) {
    lines.push("", `Documentation snippets (${response.infoSnippets.length}):`);
    for (const [index, snippet] of response.infoSnippets.entries()) {
      lines.push("", `${index + 1}. ${snippet.breadcrumb ?? "Documentation"}`);
      if (snippet.pageId) lines.push(`Source: ${snippet.pageId}`);
      lines.push(snippet.content);
    }
  }

  if (
    response.codeSnippets.length === 0 &&
    response.infoSnippets.length === 0
  ) {
    lines.push("", "No documentation snippets returned.");
  }

  return lines.join("\n");
}

async function writeTempJson(prefix: string, value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const filePath = join(dir, "response.json");
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  return filePath;
}

async function buildTextResult(
  prefix: string,
  text: string,
  jsonValue: unknown,
): Promise<{
  text: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
}> {
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) return { text: truncation.content };

  const fullOutputPath = await writeTempJson(prefix, jsonValue);
  return {
    text:
      `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
      `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
      `Full JSON saved to: ${fullOutputPath}]`,
    truncation,
    fullOutputPath,
  };
}

async function requestJson<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("Missing API key in CONTEXT7_API_KEY.");

  const url = new URL(`https://context7.com/api/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal,
  });

  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const payload =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : undefined;
    const retryAfter = response.headers.get("Retry-After");
    const redirectUrl = normalizeString(payload?.redirectUrl);
    const reason =
      normalizeString(payload?.message) ??
      normalizeString(payload?.error) ??
      (typeof body === "string" ? body : undefined) ??
      response.statusText;

    let message = `HTTP ${response.status}: ${reason}`;
    if (retryAfter) message += ` Retry-After: ${retryAfter}s.`;
    if (redirectUrl) message += ` Redirect: ${redirectUrl}`;
    throw new Error(message);
  }

  return body as T;
}

function renderMeta(details: ToolMeta, theme: Theme): string {
  const meta: string[] = [];
  if (details.fullOutputPath)
    meta.push(theme.fg("dim", `full JSON: ${details.fullOutputPath}`));
  return meta.join("  ");
}

export default function libraryDocsExtension(pi: ExtensionAPI) {
  const apiKey = getApiKey();

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(
      "library-docs",
      apiKey ? undefined : "library docs unavailable: missing API key",
    );
  });

  if (!apiKey) return;

  pi.registerTool({
    name: "library_search",
    label: "Library Search",
    description:
      "Search indexed library and framework documentation to find exact library IDs before fetching docs.",
    promptSnippet:
      "Search indexed library and framework docs to find exact library IDs before fetching documentation.",
    promptGuidelines: [
      "Use library_search when user needs current library/framework docs, setup steps, API references, or examples and exact library ID is unknown.",
      "Prefer library_docs after you know exact library ID.",
      "If user already gives exact library ID, skip search and call library_docs directly.",
    ],
    parameters: LibrarySearchParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = { ...(args as Record<string, unknown>) };
      const libraryName =
        normalizeString(input.library_name) ??
        normalizeString(input.libraryName);
      const query = normalizeString(input.query);
      if (libraryName) input.library_name = libraryName;
      if (query) input.query = query;
      return input;
    },
    async execute(_toolCallId, params, signal) {
      const response = await requestJson<SearchResponse>(
        "v2/libs/search",
        {
          libraryName: params.library_name,
          query: params.query,
        },
        signal,
      );

      const maxResults = clampMaxResults(params.max_results);
      const results = response.results.slice(0, maxResults);
      const lines: string[] = [
        `Found ${response.results.length} matching documentation librar${response.results.length === 1 ? "y" : "ies"}.`,
        `Showing ${results.length}.`,
      ];

      for (const [index, result] of results.entries()) {
        lines.push("", ...formatSearchResult(result, index));
      }

      if (results.length > 0) {
        lines.push("", "Use exact Library ID with library_docs.");
      }

      const built = await buildTextResult(
        "pi-library-search",
        lines.join("\n"),
        { ...response, shownResults: results },
      );

      return {
        content: [{ type: "text", text: built.text }],
        details: {
          libraryName: params.library_name,
          query: params.query,
          resultCount: response.results.length,
          returnedCount: results.length,
          searchFilterApplied: Boolean(response.searchFilterApplied),
          fullOutputPath: built.fullOutputPath,
          truncation: built.truncation,
        } satisfies LibrarySearchDetails,
      };
    },
    renderCall(args, theme, context) {
      if (!context.argsComplete) return HIDDEN_COMPONENT;
      let text = theme.fg("toolTitle", theme.bold("library_search "));
      text += theme.fg(
        "accent",
        JSON.stringify(
          normalizeString((args as Record<string, unknown>).library_name) ?? "",
        ),
      );
      const query = normalizeString((args as Record<string, unknown>).query);
      if (query) text += theme.fg("dim", ` ${JSON.stringify(query)}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return HIDDEN_COMPONENT;
      const details = result.details as LibrarySearchDetails | undefined;
      if (!details) return HIDDEN_COMPONENT;
      let text = theme.fg(
        "success",
        `${details.returnedCount}/${details.resultCount} match${details.resultCount === 1 ? "" : "es"}`,
      );
      text += ` ${theme.fg("muted", `for ${JSON.stringify(details.libraryName)}`)}`;
      if (details.searchFilterApplied) text += theme.fg("warning", " filtered");
      const meta = renderMeta(details, theme);
      if (meta) text += `\n${meta}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "library_docs",
    label: "Library Docs",
    description:
      "Retrieve current documentation snippets and code examples for an exact library ID.",
    promptSnippet:
      "Retrieve current library/framework documentation snippets and code examples for exact library IDs.",
    promptGuidelines: [
      "Use library_docs after library_search or when user already provides exact library ID.",
      "Pin version when user asks for version-specific docs.",
      "Use smaller token budgets when you only need focused docs for one question.",
    ],
    parameters: LibraryDocsParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = { ...(args as Record<string, unknown>) };
      const libraryId = normalizeLibraryId(
        input.library_id ?? input.libraryId ?? input.id,
      );
      const query = normalizeString(input.query);
      const version = normalizeString(input.version);
      const format = normalizeString(input.format);
      if (libraryId) input.library_id = libraryId;
      if (query) input.query = query;
      if (version) input.version = version;
      if (format === "markdown" || format === "text") input.format = format;
      return input;
    },
    async execute(_toolCallId, params, signal) {
      const resolvedLibraryId = mergeLibraryVersion(
        params.library_id,
        params.version,
      );
      const format = params.format ?? "markdown";
      const response = await requestJson<ContextResponse>(
        "v2/context",
        {
          libraryId: resolvedLibraryId,
          query: params.query,
          type: "json",
          tokens: params.tokens,
        },
        signal,
      );

      const text = formatContextText(
        response,
        resolvedLibraryId,
        params.query,
        format,
      );
      const built = await buildTextResult("pi-library-docs", text, response);
      const rulesCount = Array.isArray(response.rules)
        ? response.rules.length
        : 0;

      return {
        content: [{ type: "text", text: built.text }],
        details: {
          libraryId: resolvedLibraryId,
          query: params.query,
          codeSnippetCount: response.codeSnippets.length,
          infoSnippetCount: response.infoSnippets.length,
          rulesCount,
          format,
          fullOutputPath: built.fullOutputPath,
          truncation: built.truncation,
        } satisfies LibraryDocsDetails,
      };
    },
    renderCall(args, theme, context) {
      if (!context.argsComplete) return HIDDEN_COMPONENT;
      let text = theme.fg("toolTitle", theme.bold("library_docs "));
      const record = args as Record<string, unknown>;
      const libraryId = normalizeLibraryId(record.library_id) ?? "";
      text += theme.fg("accent", libraryId);
      const version = normalizeString(record.version);
      if (version && !libraryId.includes("@"))
        text += theme.fg("dim", ` @${version}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return HIDDEN_COMPONENT;
      const details = result.details as LibraryDocsDetails | undefined;
      if (!details) return HIDDEN_COMPONENT;
      let text = theme.fg(
        "success",
        `${details.codeSnippetCount} code + ${details.infoSnippetCount} docs`,
      );
      if (details.rulesCount > 0)
        text += theme.fg("accent", ` + ${details.rulesCount} rules`);
      text += ` ${theme.fg("muted", `from ${details.libraryId}`)}`;
      const meta = renderMeta(details, theme);
      if (meta) text += `\n${meta}`;
      return new Text(text, 0, 0);
    },
  });
}
