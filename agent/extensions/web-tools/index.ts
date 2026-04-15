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
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text, type Component } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  tavily,
  type TavilyClient,
  type TavilyCrawlOptions,
  type TavilyExtractOptions,
  type TavilyExtractResponse,
  type TavilyMapOptions,
  type TavilySearchOptions,
  type TavilySearchResponse,
} from "@tavily/core";

type SearchDepth = "basic" | "fast" | "advanced" | "ultra-fast";
type SearchTopic = "general" | "news" | "finance";
type ExtractDepth = "basic" | "advanced";
type OutputFormat = "markdown" | "text";
type AnswerMode = false | "basic" | "advanced";
type RawContentMode = false | "markdown" | "text";

type ImageResult = { url: string; description?: string };
type SearchResultWithImages = TavilySearchResponse["results"][number] & {
  images?: Array<string | ImageResult>;
};

interface ToolMeta {
  requestId?: string;
  credits?: number;
  responseTime?: number;
  fullOutputPath?: string;
  truncation?: TruncationResult;
}

interface SearchDetails extends ToolMeta {
  query: string;
  resultCount: number;
  searchDepth: SearchDepth;
  topic: SearchTopic;
  hasAnswer: boolean;
  imageCount: number;
  autoParameters?: Partial<TavilySearchOptions>;
}

interface ExtractDetails extends ToolMeta {
  urlCount: number;
  successCount: number;
  failureCount: number;
  extractDepth: ExtractDepth;
  format: OutputFormat;
  failed: TavilyExtractResponse["failedResults"];
}

interface MapDetails extends ToolMeta {
  url: string;
  resultCount: number;
  maxDepth: number;
  limit: number;
}

interface CrawlDetails extends ToolMeta {
  url: string;
  pageCount: number;
  maxDepth: number;
  limit: number;
  extractDepth: ExtractDepth;
  format: OutputFormat;
}

const SearchParams = Type.Object({
  query: Type.String({ description: "What to search for on the web" }),
  max_results: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 20,
      description: "Maximum number of results to return",
    }),
  ),
  search_depth: Type.Optional(
    Type.Union(
      [
        Type.Literal("basic"),
        Type.Literal("fast"),
        Type.Literal("advanced"),
        Type.Literal("ultra-fast"),
      ],
      { description: "Latency vs relevance tradeoff" },
    ),
  ),
  topic: Type.Optional(
    Type.Union(
      [Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")],
      { description: "Search topic specialization" },
    ),
  ),
  time_range: Type.Optional(
    Type.Union(
      [
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
        Type.Literal("d"),
        Type.Literal("w"),
        Type.Literal("m"),
        Type.Literal("y"),
      ],
      { description: "Relative freshness window" },
    ),
  ),
  start_date: Type.Optional(
    Type.String({ description: "Only results after YYYY-MM-DD" }),
  ),
  end_date: Type.Optional(
    Type.String({ description: "Only results before YYYY-MM-DD" }),
  ),
  chunks_per_source: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 3,
      description: "Relevant snippets per result for advanced search",
    }),
  ),
  include_answer: Type.Optional(
    Type.Union([
      Type.Boolean({ description: "Whether to include a synthesized answer" }),
      Type.Literal("none"),
      Type.Literal("basic"),
      Type.Literal("advanced"),
    ]),
  ),
  include_raw_content: Type.Optional(
    Type.Union([
      Type.Boolean({ description: "Whether to include parsed source content" }),
      Type.Literal("none"),
      Type.Literal("markdown"),
      Type.Literal("text"),
    ]),
  ),
  include_images: Type.Optional(
    Type.Boolean({ description: "Include image results" }),
  ),
  include_image_descriptions: Type.Optional(
    Type.Boolean({ description: "Include descriptions for returned images" }),
  ),
  include_domains: Type.Optional(
    Type.Array(Type.String({ description: "Domain to include" }), {
      description: "Only search these domains",
    }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String({ description: "Domain to exclude" }), {
      description: "Exclude these domains",
    }),
  ),
  country: Type.Optional(
    Type.String({ description: "Boost results from this country name" }),
  ),
  auto_parameters: Type.Optional(
    Type.Boolean({
      description: "Let the search engine tune search parameters automatically",
    }),
  ),
  exact_match: Type.Optional(
    Type.Boolean({ description: "Respect quoted phrases exactly" }),
  ),
  include_favicon: Type.Optional(
    Type.Boolean({ description: "Include favicon URLs" }),
  ),
  include_usage: Type.Optional(
    Type.Boolean({ description: "Include credit usage info" }),
  ),
  safe_search: Type.Optional(
    Type.Boolean({ description: "Filter unsafe content when supported" }),
  ),
  timeout: Type.Optional(
    Type.Number({ minimum: 1, maximum: 60, description: "Timeout in seconds" }),
  ),
});

const ExtractParams = Type.Object({
  urls: Type.Array(Type.String({ description: "URL to extract" }), {
    minItems: 1,
    maxItems: 20,
    description: "One or more URLs to extract",
  }),
  extract_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "Advanced handles harder pages and embedded content",
    }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
      description: "Output format",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description: "Optional reranking intent for extracted chunks",
    }),
  ),
  chunks_per_source: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 5,
      description: "Relevant chunks per URL when query is provided",
    }),
  ),
  include_images: Type.Optional(
    Type.Boolean({ description: "Include image URLs" }),
  ),
  include_favicon: Type.Optional(
    Type.Boolean({ description: "Include favicon URLs" }),
  ),
  include_usage: Type.Optional(
    Type.Boolean({ description: "Include credit usage info" }),
  ),
  timeout: Type.Optional(
    Type.Number({ minimum: 1, maximum: 60, description: "Timeout in seconds" }),
  ),
});

const MapParams = Type.Object({
  url: Type.String({ description: "Root URL to map" }),
  max_depth: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 5,
      description: "Maximum traversal depth",
    }),
  ),
  max_breadth: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 500,
      description: "Maximum links to follow per level",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ minimum: 1, description: "Maximum total URLs to discover" }),
  ),
  instructions: Type.Optional(
    Type.String({ description: "Natural-language guidance for URL discovery" }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String({ description: "Regex path filter" }), {
      description: "Only include matching paths",
    }),
  ),
  exclude_paths: Type.Optional(
    Type.Array(Type.String({ description: "Regex path exclusion" }), {
      description: "Skip matching paths",
    }),
  ),
  select_domains: Type.Optional(
    Type.Array(Type.String({ description: "Regex domain filter" }), {
      description: "Only include matching domains",
    }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String({ description: "Regex domain exclusion" }), {
      description: "Skip matching domains",
    }),
  ),
  allow_external: Type.Optional(
    Type.Boolean({ description: "Include external-domain links" }),
  ),
  include_usage: Type.Optional(
    Type.Boolean({ description: "Include credit usage info" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      minimum: 10,
      maximum: 150,
      description: "Timeout in seconds",
    }),
  ),
});

const CrawlParams = Type.Object({
  url: Type.String({ description: "Root URL to crawl" }),
  max_depth: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 5,
      description: "Maximum traversal depth",
    }),
  ),
  max_breadth: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 500,
      description: "Maximum links to follow per level",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ minimum: 1, description: "Maximum total pages to crawl" }),
  ),
  instructions: Type.Optional(
    Type.String({
      description: "Natural-language guidance for focused crawling",
    }),
  ),
  chunks_per_source: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 5,
      description: "Relevant chunks per page when instructions are provided",
    }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String({ description: "Regex path filter" }), {
      description: "Only crawl matching paths",
    }),
  ),
  exclude_paths: Type.Optional(
    Type.Array(Type.String({ description: "Regex path exclusion" }), {
      description: "Skip matching paths",
    }),
  ),
  select_domains: Type.Optional(
    Type.Array(Type.String({ description: "Regex domain filter" }), {
      description: "Only crawl matching domains",
    }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String({ description: "Regex domain exclusion" }), {
      description: "Skip matching domains",
    }),
  ),
  allow_external: Type.Optional(
    Type.Boolean({ description: "Include external-domain links" }),
  ),
  extract_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "Advanced extracts harder content",
    }),
  ),
  format: Type.Optional(
    Type.Union([Type.Literal("markdown"), Type.Literal("text")], {
      description: "Output format",
    }),
  ),
  include_images: Type.Optional(
    Type.Boolean({ description: "Include image URLs" }),
  ),
  include_favicon: Type.Optional(
    Type.Boolean({ description: "Include favicon URLs" }),
  ),
  include_usage: Type.Optional(
    Type.Boolean({ description: "Include credit usage info" }),
  ),
  timeout: Type.Optional(
    Type.Number({
      minimum: 10,
      maximum: 150,
      description: "Timeout in seconds",
    }),
  ),
});

const HIDDEN_COMPONENT: Component = {
  render() {
    return [];
  },
  invalidate() {},
};

function normalizeStringArray(
  value: unknown,
  splitCommas = false,
): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value !== "string") return undefined;
  const items = value
    .split(splitCommas ? /[\n,]/ : /\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function normalizeQuery(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  const queries = normalizeStringArray(value, true);
  if (!queries || queries.length === 0) return undefined;

  // Gemini sometimes emits `queries: [...]` for the first search call in a
  // fresh session even though the schema expects a single `query` string.
  // Accept the first useful query instead of forcing a noisy retry.
  return queries[0];
}

function normalizeAnswerMode(value: unknown): AnswerMode {
  if (value === true) return "basic";
  if (value === "basic" || value === "advanced") return value;
  return false;
}

function normalizeRawContentMode(value: unknown): RawContentMode {
  if (value === true) return "markdown";
  if (value === "markdown" || value === "text") return value;
  return false;
}

function formatList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : undefined;
}

function getArrayLength(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return Array.isArray(record[key]) ? record[key].length : undefined;
}

function formatSeconds(value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${value.toFixed(2)}s`;
}

function renderMeta(details: ToolMeta, theme: Theme): string {
  const meta: string[] = [];
  if (details.requestId)
    meta.push(theme.fg("dim", `request ${details.requestId}`));
  if (details.credits !== undefined) {
    meta.push(
      theme.fg(
        "dim",
        `${details.credits} credit${details.credits === 1 ? "" : "s"}`,
      ),
    );
  }
  const responseTime = formatSeconds(details.responseTime);
  if (responseTime) meta.push(theme.fg("dim", responseTime));
  if (details.fullOutputPath)
    meta.push(theme.fg("dim", `full JSON: ${details.fullOutputPath}`));
  return meta.join("  ");
}

async function writeTempJson(prefix: string, value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const filePath = join(dir, "response.json");
  await withFileMutationQueue(filePath, async () => {
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
  });
  return filePath;
}

async function buildTextResult(
  prefix: string,
  text: string,
  jsonValue: unknown,
) {
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

function createClient(): TavilyClient | undefined {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return undefined;
  return tavily({
    apiKey,
    projectId: process.env.TAVILY_PROJECT,
    clientSource: "web-tools",
  });
}

export default function webToolsExtension(pi: ExtensionAPI) {
  const client = createClient();

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus(
      "web-tools",
      client ? undefined : "web tools unavailable: missing API key",
    );
  });

  if (!client) return;

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the live web with ranked results and optional extracted snippets. Best for discovery, current information, and finding candidate URLs before extraction.",
    promptSnippet:
      "Search the live web for current information or to find relevant URLs before extracting content.",
    promptGuidelines: [
      "Use web_search for discovery and current information.",
      "If you already know the target URL, prefer web_extract instead of searching first.",
      "For documentation sites, search first, then map or extract the most relevant URLs.",
    ],
    parameters: SearchParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = { ...(args as Record<string, unknown>) };
      const query = normalizeQuery(input.query ?? input.queries);
      if (query) input.query = query;
      const includeDomains = normalizeStringArray(input.include_domains, true);
      const excludeDomains = normalizeStringArray(input.exclude_domains, true);
      if (includeDomains) input.include_domains = includeDomains;
      if (excludeDomains) input.exclude_domains = excludeDomains;
      if ("include_answer" in input)
        input.include_answer = normalizeAnswerMode(input.include_answer);
      if ("include_raw_content" in input) {
        input.include_raw_content = normalizeRawContentMode(
          input.include_raw_content,
        );
      }
      return input;
    },
    async execute(_toolCallId, params) {
      const searchDepth = params.search_depth ?? "basic";
      const topic = params.topic ?? "general";
      const response = await client.search(params.query, {
        searchDepth,
        topic,
        maxResults: params.max_results,
        timeRange: params.time_range,
        startDate: params.start_date,
        endDate: params.end_date,
        chunksPerSource: params.chunks_per_source,
        includeAnswer: normalizeAnswerMode(params.include_answer),
        includeRawContent: normalizeRawContentMode(params.include_raw_content),
        includeImages: params.include_images,
        includeImageDescriptions: params.include_image_descriptions,
        includeDomains: params.include_domains,
        excludeDomains: params.exclude_domains,
        country: params.country,
        autoParameters: params.auto_parameters,
        exactMatch: params.exact_match,
        includeFavicon: params.include_favicon,
        includeUsage: params.include_usage ?? true,
        safe_search: params.safe_search,
        timeout: params.timeout,
      });

      const lines: string[] = [];
      if (response.answer) lines.push("Answer:", response.answer, "");

      lines.push(
        `Found ${response.results.length} result${response.results.length === 1 ? "" : "s"} for: ${response.query}`,
      );
      for (const [index, rawResult] of response.results.entries()) {
        const result = rawResult as SearchResultWithImages;
        lines.push(
          "",
          `${index + 1}. ${result.title}`,
          `URL: ${result.url}`,
          `Score: ${result.score.toFixed(3)}`,
        );
        if (result.publishedDate)
          lines.push(`Published: ${result.publishedDate}`);
        if (result.favicon) lines.push(`Favicon: ${result.favicon}`);
        lines.push(result.content);
        if (result.rawContent)
          lines.push("", "Raw content:", result.rawContent);
        if (result.images && result.images.length > 0) {
          lines.push("", "Result images:");
          for (const image of result.images) {
            lines.push(
              typeof image === "string"
                ? `- ${image}`
                : `- ${image.url}${image.description ? ` :: ${image.description}` : ""}`,
            );
          }
        }
      }

      if (response.images.length > 0) {
        lines.push("", "Images:");
        for (const image of response.images) {
          lines.push(
            `- ${image.url}${image.description ? ` :: ${image.description}` : ""}`,
          );
        }
      }

      const built = await buildTextResult(
        "pi-web-search",
        lines.join("\n"),
        response,
      );
      return {
        content: [{ type: "text", text: built.text }],
        details: {
          query: response.query,
          resultCount: response.results.length,
          searchDepth,
          topic,
          hasAnswer: Boolean(response.answer),
          imageCount: response.images.length,
          requestId: response.requestId,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
          autoParameters: response.autoParameters,
          fullOutputPath: built.fullOutputPath,
          truncation: built.truncation,
        } as SearchDetails,
      };
    },
    renderCall(args, theme, context) {
      if (!context.argsComplete) return HIDDEN_COMPONENT;
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      const query = normalizeQuery(
        getString(args, "query") ?? (args as Record<string, unknown>).queries,
      );
      text += theme.fg("accent", JSON.stringify(query ?? ""));
      const topic = getString(args, "topic");
      const searchDepth = getString(args, "search_depth");
      if (topic) text += theme.fg("dim", ` ${topic}`);
      if (searchDepth) text += theme.fg("dim", ` ${searchDepth}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return HIDDEN_COMPONENT;
      const details = result.details as SearchDetails | undefined;
      if (!details) return HIDDEN_COMPONENT;
      let text = theme.fg(
        "success",
        `${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`,
      );
      if (details.hasAnswer) text += theme.fg("accent", " with answer");
      text += ` ${theme.fg("muted", `for ${JSON.stringify(details.query)}`)}`;
      const meta = renderMeta(details, theme);
      if (meta) text += `\n${meta}`;
      if (expanded && details.autoParameters) {
        text += `\n${theme.fg("dim", `auto: ${JSON.stringify(details.autoParameters)}`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_extract",
    label: "Web Extract",
    description:
      "Extract clean markdown or text from one or more known URLs. Best when the target pages are already known and you want their contents, not search results.",
    promptSnippet: "Extract clean markdown or text from known URLs.",
    promptGuidelines: [
      "Use web_extract when you already know the exact URL or have just found it with web_search or web_map.",
      "Use query and chunks_per_source when you only need parts relevant to a specific question.",
    ],
    parameters: ExtractParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = { ...(args as Record<string, unknown>) };
      const urls = normalizeStringArray(input.urls, true);
      if (urls) input.urls = urls;
      return input;
    },
    async execute(_toolCallId, params) {
      const extractDepth = params.extract_depth ?? "basic";
      const format = params.format ?? "markdown";
      const response = await client.extract(params.urls, {
        extractDepth,
        format,
        query: params.query,
        chunksPerSource: params.chunks_per_source,
        includeImages: params.include_images,
        includeFavicon: params.include_favicon,
        includeUsage: params.include_usage ?? true,
        timeout: params.timeout,
      } satisfies TavilyExtractOptions);

      const lines: string[] = [
        `Extracted ${response.results.length} of ${params.urls.length} URL${params.urls.length === 1 ? "" : "s"}.`,
      ];
      for (const result of response.results) {
        lines.push("", `URL: ${result.url}`);
        if (result.favicon) lines.push(`Favicon: ${result.favicon}`);
        lines.push(result.rawContent || "(No content returned)");
        if (result.images && result.images.length > 0) {
          lines.push("", "Images:", formatList(result.images));
        }
      }
      if (response.failedResults.length > 0) {
        lines.push("", "Failed:");
        for (const item of response.failedResults)
          lines.push(`- ${item.url} :: ${item.error}`);
      }

      const built = await buildTextResult(
        "pi-web-extract",
        lines.join("\n"),
        response,
      );
      return {
        content: [{ type: "text", text: built.text }],
        details: {
          urlCount: params.urls.length,
          successCount: response.results.length,
          failureCount: response.failedResults.length,
          extractDepth,
          format,
          failed: response.failedResults,
          requestId: response.requestId,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
          fullOutputPath: built.fullOutputPath,
          truncation: built.truncation,
        } as ExtractDetails,
      };
    },
    renderCall(args, theme, context) {
      if (!context.argsComplete) return HIDDEN_COMPONENT;
      let text = theme.fg("toolTitle", theme.bold("web_extract "));
      const urlCount = getArrayLength(args, "urls");
      text += theme.fg(
        "accent",
        urlCount === undefined
          ? ""
          : `${urlCount} URL${urlCount === 1 ? "" : "s"}`,
      );
      const query = getString(args, "query");
      if (query) text += theme.fg("dim", ` query=${JSON.stringify(query)}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return HIDDEN_COMPONENT;
      const details = result.details as ExtractDetails | undefined;
      if (!details) return HIDDEN_COMPONENT;
      let text = theme.fg(
        "success",
        `${details.successCount}/${details.urlCount} extracted`,
      );
      if (details.failureCount > 0)
        text += theme.fg("warning", `, ${details.failureCount} failed`);
      const meta = renderMeta(details, theme);
      if (meta) text += `\n${meta}`;
      if (expanded && details.failed.length > 0) {
        for (const item of details.failed)
          text += `\n${theme.fg("error", `${item.url} :: ${item.error}`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_map",
    label: "Web Map",
    description:
      "Discover URLs on a website without extracting page content. Best for locating the right documentation or content pages before extraction or crawl.",
    promptSnippet:
      "Discover URLs on a website before deciding what to extract or crawl.",
    promptGuidelines: [
      "Prefer web_map before web_crawl when you first need to understand a site's structure.",
      "After mapping, use web_extract on the most relevant URLs instead of crawling the whole site unless broad coverage is needed.",
    ],
    parameters: MapParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = { ...(args as Record<string, unknown>) };
      for (const key of [
        "select_paths",
        "exclude_paths",
        "select_domains",
        "exclude_domains",
      ] as const) {
        const values = normalizeStringArray(input[key]);
        if (values) input[key] = values;
      }
      return input;
    },
    async execute(_toolCallId, params) {
      const maxDepth = params.max_depth ?? 1;
      const limit = params.limit ?? 50;
      const response = await client.map(params.url, {
        maxDepth,
        maxBreadth: params.max_breadth,
        limit,
        instructions: params.instructions,
        selectPaths: params.select_paths,
        excludePaths: params.exclude_paths,
        selectDomains: params.select_domains,
        excludeDomains: params.exclude_domains,
        allowExternal: params.allow_external,
        includeUsage: params.include_usage ?? true,
        timeout: params.timeout,
      } satisfies TavilyMapOptions);

      const built = await buildTextResult(
        "pi-web-map",
        [
          `Mapped ${response.baseUrl}`,
          `Discovered ${response.results.length} URL${response.results.length === 1 ? "" : "s"}.`,
          "",
          ...response.results.map((url, index) => `${index + 1}. ${url}`),
        ].join("\n"),
        response,
      );

      return {
        content: [{ type: "text", text: built.text }],
        details: {
          url: response.baseUrl,
          resultCount: response.results.length,
          maxDepth,
          limit,
          requestId: response.requestId,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
          fullOutputPath: built.fullOutputPath,
          truncation: built.truncation,
        } as MapDetails,
      };
    },
    renderCall(args, theme, context) {
      if (!context.argsComplete) return HIDDEN_COMPONENT;
      let text = theme.fg("toolTitle", theme.bold("web_map "));
      text += theme.fg("accent", getString(args, "url") ?? "");
      if (getString(args, "instructions")) text += theme.fg("dim", " guided");
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return HIDDEN_COMPONENT;
      const details = result.details as MapDetails | undefined;
      if (!details) return HIDDEN_COMPONENT;
      let text = theme.fg(
        "success",
        `${details.resultCount} URL${details.resultCount === 1 ? "" : "s"} discovered`,
      );
      text += ` ${theme.fg("muted", `from ${details.url}`)}`;
      const meta = renderMeta(details, theme);
      if (meta) text += `\n${meta}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "web_crawl",
    label: "Web Crawl",
    description:
      "Crawl a website and extract content from multiple pages. Best for focused site-wide collection after search or map has established scope.",
    promptSnippet:
      "Crawl a site to collect content from multiple related pages.",
    promptGuidelines: [
      "Use web_crawl only when multiple pages are needed; avoid broad crawls when a few targeted extracts will do.",
      "Constrain crawls with instructions, select_paths, exclude_paths, and small limits whenever possible.",
    ],
    parameters: CrawlParams,
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = { ...(args as Record<string, unknown>) };
      for (const key of [
        "select_paths",
        "exclude_paths",
        "select_domains",
        "exclude_domains",
      ] as const) {
        const values = normalizeStringArray(input[key]);
        if (values) input[key] = values;
      }
      return input;
    },
    async execute(_toolCallId, params) {
      const maxDepth = params.max_depth ?? 1;
      const limit = params.limit ?? 50;
      const extractDepth = params.extract_depth ?? "basic";
      const format = params.format ?? "markdown";
      const response = await client.crawl(params.url, {
        maxDepth,
        maxBreadth: params.max_breadth,
        limit,
        instructions: params.instructions,
        chunksPerSource: params.chunks_per_source,
        selectPaths: params.select_paths,
        excludePaths: params.exclude_paths,
        selectDomains: params.select_domains,
        excludeDomains: params.exclude_domains,
        allowExternal: params.allow_external,
        extractDepth,
        format,
        includeImages: params.include_images,
        includeFavicon: params.include_favicon,
        includeUsage: params.include_usage ?? true,
        timeout: params.timeout,
      } satisfies TavilyCrawlOptions);

      const lines: string[] = [
        `Crawled ${response.baseUrl}`,
        `Collected ${response.results.length} page${response.results.length === 1 ? "" : "s"}.`,
      ];
      for (const [index, item] of response.results.entries()) {
        const images = item.images ?? [];
        lines.push("", `${index + 1}. ${item.url}`);
        if (item.favicon) lines.push(`Favicon: ${item.favicon}`);
        lines.push(item.rawContent || "(No content returned)");
        if (images.length > 0) lines.push("", "Images:", formatList(images));
      }

      const built = await buildTextResult(
        "pi-web-crawl",
        lines.join("\n"),
        response,
      );
      return {
        content: [{ type: "text", text: built.text }],
        details: {
          url: response.baseUrl,
          pageCount: response.results.length,
          maxDepth,
          limit,
          extractDepth,
          format,
          requestId: response.requestId,
          responseTime: response.responseTime,
          credits: response.usage?.credits,
          fullOutputPath: built.fullOutputPath,
          truncation: built.truncation,
        } as CrawlDetails,
      };
    },
    renderCall(args, theme, context) {
      if (!context.argsComplete) return HIDDEN_COMPONENT;
      let text = theme.fg("toolTitle", theme.bold("web_crawl "));
      text += theme.fg("accent", getString(args, "url") ?? "");
      if (getString(args, "instructions")) text += theme.fg("dim", " guided");
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return HIDDEN_COMPONENT;
      const details = result.details as CrawlDetails | undefined;
      if (!details) return HIDDEN_COMPONENT;
      let text = theme.fg(
        "success",
        `${details.pageCount} page${details.pageCount === 1 ? "" : "s"} collected`,
      );
      text += ` ${theme.fg("muted", `from ${details.url}`)}`;
      const meta = renderMeta(details, theme);
      if (meta) text += `\n${meta}`;
      return new Text(text, 0, 0);
    },
  });
}
