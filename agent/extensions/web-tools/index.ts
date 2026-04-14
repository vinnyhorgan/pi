import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tavily } from "@tavily/core";
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
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type SearchDepth = "basic" | "fast" | "advanced" | "ultra-fast";
type SearchTopic = "general" | "news" | "finance";
type ExtractDepth = "basic" | "advanced";
type OutputFormat = "markdown" | "text";

interface ImageResult {
	url: string;
	description?: string;
}

interface SearchResult {
	title: string;
	url: string;
	content: string;
	score: number;
	rawContent?: string;
	publishedDate?: string;
	favicon?: string;
	images?: Array<string | ImageResult>;
}

interface SearchResponse {
	query: string;
	results: SearchResult[];
	answer?: string;
	images?: Array<string | ImageResult>;
	requestId?: string;
	request_id?: string;
	responseTime?: number;
	response_time?: number;
	usage?: { credits?: number };
	autoParameters?: Record<string, unknown>;
	auto_parameters?: Record<string, unknown>;
}

interface ExtractResult {
	url: string;
	rawContent?: string;
	raw_content?: string;
	images?: string[];
	favicon?: string;
}

interface ExtractFailure {
	url: string;
	error: string;
}

interface ExtractResponse {
	results: ExtractResult[];
	failedResults?: ExtractFailure[];
	failed_results?: ExtractFailure[];
	requestId?: string;
	request_id?: string;
	responseTime?: number;
	response_time?: number;
	usage?: { credits?: number };
}

interface MapResponse {
	baseUrl?: string;
	base_url?: string;
	results: string[];
	requestId?: string;
	request_id?: string;
	responseTime?: number;
	response_time?: number;
	usage?: { credits?: number };
}

interface CrawlResult {
	url: string;
	rawContent?: string;
	raw_content?: string;
	images?: string[];
	favicon?: string;
}

interface CrawlResponse {
	baseUrl?: string;
	base_url?: string;
	results: CrawlResult[];
	requestId?: string;
	request_id?: string;
	responseTime?: number;
	response_time?: number;
	usage?: { credits?: number };
}

interface ToolMeta {
	requestId?: string;
	credits?: number;
	responseTime?: number;
	fullOutputPath?: string;
	truncation?: TruncationResult;
	warnings?: string[];
}

interface SearchDetails extends ToolMeta {
	query: string;
	resultCount: number;
	searchDepth: SearchDepth;
	topic: SearchTopic;
	hasAnswer: boolean;
	imageCount: number;
	autoParameters?: Record<string, unknown>;
}

interface ExtractDetails extends ToolMeta {
	urlCount: number;
	successCount: number;
	failureCount: number;
	extractDepth: ExtractDepth;
	format: OutputFormat;
	failed: ExtractFailure[];
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
	max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum number of results to return" })),
	search_depth: Type.Optional(
		StringEnum(["basic", "fast", "advanced", "ultra-fast"] as const, {
			description: "Latency vs relevance tradeoff",
		}),
	),
	topic: Type.Optional(
		StringEnum(["general", "news", "finance"] as const, { description: "Search topic specialization" }),
	),
	time_range: Type.Optional(
		StringEnum(["day", "week", "month", "year"] as const, { description: "Relative freshness window" }),
	),
	start_date: Type.Optional(Type.String({ description: "Only results after YYYY-MM-DD" })),
	end_date: Type.Optional(Type.String({ description: "Only results before YYYY-MM-DD" })),
	include_answer: Type.Optional(
		StringEnum(["none", "basic", "advanced"] as const, { description: "Include a synthesized answer" }),
	),
	include_raw_content: Type.Optional(
		StringEnum(["none", "markdown", "text"] as const, { description: "Include parsed source content in results" }),
	),
	include_images: Type.Optional(Type.Boolean({ description: "Include image results" })),
	include_image_descriptions: Type.Optional(Type.Boolean({ description: "Include descriptions for returned images" })),
	include_domains: Type.Optional(Type.Array(Type.String({ description: "Domain to include" }), { description: "Only search these domains" })),
	exclude_domains: Type.Optional(Type.Array(Type.String({ description: "Domain to exclude" }), { description: "Exclude these domains" })),
	country: Type.Optional(Type.String({ description: "Boost results from this country name" })),
	exact_match: Type.Optional(Type.Boolean({ description: "Respect quoted phrases exactly" })),
	include_favicon: Type.Optional(Type.Boolean({ description: "Include favicon URLs" })),
});

const ExtractParams = Type.Object({
	urls: Type.Array(Type.String({ description: "URL to extract" }), {
		minItems: 1,
		maxItems: 20,
		description: "One or more URLs to extract",
	}),
	extract_depth: Type.Optional(
		StringEnum(["basic", "advanced"] as const, { description: "Advanced handles harder pages and embedded content" }),
	),
	format: Type.Optional(StringEnum(["markdown", "text"] as const, { description: "Output format" })),
	query: Type.Optional(Type.String({ description: "Optional reranking intent for extracted chunks" })),
	chunks_per_source: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: "Relevant chunks per URL when query is provided" })),
	include_images: Type.Optional(Type.Boolean({ description: "Include image URLs" })),
	include_favicon: Type.Optional(Type.Boolean({ description: "Include favicon URLs" })),
	timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 60, description: "Timeout in seconds" })),
});

const MapParams = Type.Object({
	url: Type.String({ description: "Root URL to map" }),
	max_depth: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: "Maximum traversal depth" })),
	max_breadth: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Maximum links to follow per level" })),
	limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum total URLs to discover" })),
	instructions: Type.Optional(Type.String({ description: "Natural-language guidance for URL discovery" })),
	select_paths: Type.Optional(Type.Array(Type.String({ description: "Regex path filter" }), { description: "Only include matching paths" })),
	exclude_paths: Type.Optional(Type.Array(Type.String({ description: "Regex path exclusion" }), { description: "Skip matching paths" })),
	select_domains: Type.Optional(Type.Array(Type.String({ description: "Regex domain filter" }), { description: "Only include matching domains" })),
	exclude_domains: Type.Optional(Type.Array(Type.String({ description: "Regex domain exclusion" }), { description: "Skip matching domains" })),
	allow_external: Type.Optional(Type.Boolean({ description: "Include external-domain links" })),
	timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 150, description: "Timeout in seconds" })),
});

const CrawlParams = Type.Object({
	url: Type.String({ description: "Root URL to crawl" }),
	max_depth: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: "Maximum traversal depth" })),
	max_breadth: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Maximum links to follow per level" })),
	limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum total pages to crawl" })),
	instructions: Type.Optional(Type.String({ description: "Natural-language guidance for focused crawling" })),
	chunks_per_source: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: "Relevant chunks per page when instructions are provided" })),
	select_paths: Type.Optional(Type.Array(Type.String({ description: "Regex path filter" }), { description: "Only crawl matching paths" })),
	exclude_paths: Type.Optional(Type.Array(Type.String({ description: "Regex path exclusion" }), { description: "Skip matching paths" })),
	select_domains: Type.Optional(Type.Array(Type.String({ description: "Regex domain filter" }), { description: "Only crawl matching domains" })),
	exclude_domains: Type.Optional(Type.Array(Type.String({ description: "Regex domain exclusion" }), { description: "Skip matching domains" })),
	allow_external: Type.Optional(Type.Boolean({ description: "Include external-domain links" })),
	extract_depth: Type.Optional(
		StringEnum(["basic", "advanced"] as const, { description: "Advanced extracts harder content" }),
	),
	format: Type.Optional(StringEnum(["markdown", "text"] as const, { description: "Output format" })),
	include_images: Type.Optional(Type.Boolean({ description: "Include image URLs" })),
	include_favicon: Type.Optional(Type.Boolean({ description: "Include favicon URLs" })),
	timeout: Type.Optional(Type.Number({ minimum: 10, maximum: 150, description: "Timeout in seconds" })),
});

function formatSeconds(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	return `${value.toFixed(2)}s`;
}

function getRequestId(response: { requestId?: string; request_id?: string }): string | undefined {
	return response.requestId ?? response.request_id;
}

function getResponseTime(response: { responseTime?: number; response_time?: number }): number | undefined {
	return response.responseTime ?? response.response_time;
}

function coerceRawContent(result: { rawContent?: string; raw_content?: string }): string {
	return result.rawContent ?? result.raw_content ?? "";
}

async function writeTempJson(prefix: string, value: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
	const filePath = join(dir, "response.json");
	await withFileMutationQueue(filePath, async () => {
		await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
	});
	return filePath;
}

async function buildTextResult(prefix: string, text: string, jsonValue: unknown) {
	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (!truncation.truncated) {
		return { text: truncation.content };
	}

	const fullOutputPath = await writeTempJson(prefix, jsonValue);
	const resultText =
		`${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
		`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
		`Full JSON saved to: ${fullOutputPath}]`;

	return { text: resultText, truncation, fullOutputPath };
}

function listLines(items: string[]): string {
	return items.map((item) => `- ${item}`).join("\n");
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value === "string") {
		const items = value
			.split(/[\n,]/)
			.map((item) => item.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}

function coerceCommonListArguments<T extends Record<string, unknown>>(args: unknown, keys: Array<keyof T>): T | unknown {
	if (!args || typeof args !== "object") return args;
	const input = { ...(args as Record<string, unknown>) };
	for (const key of keys) {
		const normalized = normalizeStringArray(input[key as string]);
		if (normalized) input[key as string] = normalized;
	}
	return input;
}

function renderMeta(details: ToolMeta, theme: Theme): string {
	const meta: string[] = [];
	if (details.requestId) meta.push(theme.fg("dim", `request ${details.requestId}`));
	if (details.credits !== undefined) meta.push(theme.fg("dim", `${details.credits} credit${details.credits === 1 ? "" : "s"}`));
	const responseTime = formatSeconds(details.responseTime);
	if (responseTime) meta.push(theme.fg("dim", responseTime));
	if (details.fullOutputPath) meta.push(theme.fg("dim", `full JSON: ${details.fullOutputPath}`));
	return meta.join("  ");
}

function createClient() {
	const apiKey = process.env.TAVILY_API_KEY;
	if (!apiKey) {
		throw new Error("Missing TAVILY_API_KEY. Export your Tavily API key before using web tools.");
	}

	const projectId = process.env.TAVILY_PROJECT;
	return tavily(projectId ? { apiKey, projectId } : { apiKey });
}

export default function webToolsExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus(
			"web-tools",
			process.env.TAVILY_API_KEY ? undefined : "web tools unavailable: set TAVILY_API_KEY",
		);
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web with LLM-optimized ranking and optional extracted snippets. Best for discovery, current information, and finding candidate URLs before extraction.",
		promptSnippet: "Search the live web for current information or to find relevant URLs before extracting content.",
		promptGuidelines: [
			"Use web_search for discovery and current information.",
			"If you already know the target URL, prefer web_extract instead of searching first.",
			"For documentation sites, search first, then map or extract the most relevant URLs.",
		],
		parameters: SearchParams,
		prepareArguments(args) {
			return coerceCommonListArguments(args, ["include_domains", "exclude_domains"]);
		},
		async execute(_toolCallId, params) {
			const client = createClient();
			const searchDepth = params.search_depth ?? "basic";
			const topic = params.topic ?? "general";
			const response = (await client.search(params.query, {
				maxResults: params.max_results,
				searchDepth,
				topic,
				timeRange: params.time_range,
				startDate: params.start_date,
				endDate: params.end_date,
				includeAnswer:
					params.include_answer === undefined || params.include_answer === "none"
						? false
						: params.include_answer,
				includeRawContent:
					params.include_raw_content === undefined || params.include_raw_content === "none"
						? false
						: params.include_raw_content,
				includeImages: params.include_images,
				includeImageDescriptions: params.include_image_descriptions,
				includeDomains: params.include_domains,
				excludeDomains: params.exclude_domains,
				country: params.country,
				exactMatch: params.exact_match,
				includeFavicon: params.include_favicon,
				includeUsage: true,
			})) as SearchResponse;

			const lines: string[] = [];
			if (response.answer) {
				lines.push("Answer:");
				lines.push(response.answer);
				lines.push("");
			}

			lines.push(`Found ${response.results.length} result${response.results.length === 1 ? "" : "s"} for: ${response.query}`);
			for (const [index, result] of response.results.entries()) {
				lines.push("");
				lines.push(`${index + 1}. ${result.title}`);
				lines.push(`URL: ${result.url}`);
				lines.push(`Score: ${result.score.toFixed(3)}`);
				if (result.publishedDate) lines.push(`Published: ${result.publishedDate}`);
				if (result.favicon) lines.push(`Favicon: ${result.favicon}`);
				lines.push(result.content);
				if (result.rawContent) {
					lines.push("");
					lines.push("Raw content:");
					lines.push(result.rawContent);
				}
			}

			if (response.images && response.images.length > 0) {
				lines.push("");
				lines.push("Images:");
				for (const image of response.images) {
					if (typeof image === "string") lines.push(`- ${image}`);
					else lines.push(`- ${image.url}${image.description ? ` :: ${image.description}` : ""}`);
				}
			}

			const built = await buildTextResult("pi-web-search", lines.join("\n"), response);
			return {
				content: [{ type: "text", text: built.text }],
				details: {
					query: response.query,
					resultCount: response.results.length,
					searchDepth,
					topic,
					hasAnswer: Boolean(response.answer),
					imageCount: response.images?.length ?? 0,
					requestId: getRequestId(response),
					responseTime: getResponseTime(response),
					credits: response.usage?.credits,
					autoParameters: response.autoParameters ?? response.auto_parameters,
					fullOutputPath: built.fullOutputPath,
					truncation: built.truncation,
				} as SearchDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_search "));
			text += theme.fg("accent", JSON.stringify(args.query));
			if (args.topic) text += theme.fg("dim", ` ${args.topic}`);
			if (args.search_depth) text += theme.fg("dim", ` ${args.search_depth}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as SearchDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No search details"), 0, 0);
			let text = theme.fg("success", `${details.resultCount} result${details.resultCount === 1 ? "" : "s"}`);
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
			const urls = normalizeStringArray(input.urls);
			if (urls) input.urls = urls;
			return input;
		},
		async execute(_toolCallId, params) {
			const client = createClient();
			const extractDepth = params.extract_depth ?? "basic";
			const format = params.format ?? "markdown";
			const response = (await client.extract(params.urls, {
				extractDepth,
				format,
				query: params.query,
				chunksPerSource: params.chunks_per_source,
				includeImages: params.include_images,
				includeFavicon: params.include_favicon,
				timeout: params.timeout,
				includeUsage: true,
			})) as ExtractResponse;

			const failed = response.failedResults ?? response.failed_results ?? [];
			const lines: string[] = [`Extracted ${response.results.length} of ${params.urls.length} URL${params.urls.length === 1 ? "" : "s"}.`];
			for (const result of response.results) {
				lines.push("");
				lines.push(`URL: ${result.url}`);
				if (result.favicon) lines.push(`Favicon: ${result.favicon}`);
				const rawContent = coerceRawContent(result);
				lines.push(rawContent || "(No content returned)");
				if (result.images && result.images.length > 0) {
					lines.push("");
					lines.push("Images:");
					lines.push(listLines(result.images));
				}
			}
			if (failed.length > 0) {
				lines.push("");
				lines.push("Failed:");
				for (const item of failed) lines.push(`- ${item.url} :: ${item.error}`);
			}

			const built = await buildTextResult("pi-web-extract", lines.join("\n"), response);
			return {
				content: [{ type: "text", text: built.text }],
				details: {
					urlCount: params.urls.length,
					successCount: response.results.length,
					failureCount: failed.length,
					extractDepth,
					format,
					failed,
					requestId: getRequestId(response),
					responseTime: getResponseTime(response),
					credits: response.usage?.credits,
					fullOutputPath: built.fullOutputPath,
					truncation: built.truncation,
				} as ExtractDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_extract "));
			text += theme.fg("accent", `${args.urls.length} URL${args.urls.length === 1 ? "" : "s"}`);
			if (args.query) text += theme.fg("dim", ` query=${JSON.stringify(args.query)}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ExtractDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No extraction details"), 0, 0);
			let text = theme.fg("success", `${details.successCount}/${details.urlCount} extracted`);
			if (details.failureCount > 0) text += theme.fg("warning", `, ${details.failureCount} failed`);
			const meta = renderMeta(details, theme);
			if (meta) text += `\n${meta}`;
			if (expanded && details.failed.length > 0) {
				for (const item of details.failed) {
					text += `\n${theme.fg("error", `${item.url} :: ${item.error}`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "web_map",
		label: "Web Map",
		description:
			"Discover URLs on a website without extracting page content. Best for locating the right documentation or content pages before extraction or crawl.",
		promptSnippet: "Discover URLs on a website before deciding what to extract or crawl.",
		promptGuidelines: [
			"Prefer web_map before web_crawl when you first need to understand a site's structure.",
			"After mapping, use web_extract on the most relevant URLs instead of crawling the whole site unless broad coverage is needed.",
		],
		parameters: MapParams,
		prepareArguments(args) {
			return coerceCommonListArguments(args, ["select_paths", "exclude_paths", "select_domains", "exclude_domains"]);
		},
		async execute(_toolCallId, params) {
			const client = createClient();
			const maxDepth = params.max_depth ?? 1;
			const limit = params.limit ?? 50;
			const response = (await client.map(params.url, {
				maxDepth,
				maxBreadth: params.max_breadth,
				limit,
				instructions: params.instructions,
				selectPaths: params.select_paths,
				excludePaths: params.exclude_paths,
				selectDomains: params.select_domains,
				excludeDomains: params.exclude_domains,
				allowExternal: params.allow_external,
				timeout: params.timeout,
				includeUsage: true,
			})) as MapResponse;

			const lines = [
				`Mapped ${response.baseUrl ?? response.base_url ?? params.url}`,
				`Discovered ${response.results.length} URL${response.results.length === 1 ? "" : "s"}.`,
				"",
				...response.results.map((url, index) => `${index + 1}. ${url}`),
			];

			const built = await buildTextResult("pi-web-map", lines.join("\n"), response);
			return {
				content: [{ type: "text", text: built.text }],
				details: {
					url: response.baseUrl ?? response.base_url ?? params.url,
					resultCount: response.results.length,
					maxDepth,
					limit,
					requestId: getRequestId(response),
					responseTime: getResponseTime(response),
					credits: response.usage?.credits,
					fullOutputPath: built.fullOutputPath,
					truncation: built.truncation,
				} as MapDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_map "));
			text += theme.fg("accent", args.url);
			if (args.instructions) text += theme.fg("dim", " guided");
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as MapDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No map details"), 0, 0);
			let text = theme.fg("success", `${details.resultCount} URL${details.resultCount === 1 ? "" : "s"} discovered`);
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
		promptSnippet: "Crawl a site to collect content from multiple related pages.",
		promptGuidelines: [
			"Use web_crawl only when multiple pages are needed; avoid broad crawls when a few targeted extracts will do.",
			"Constrain crawls with instructions, select_paths, exclude_paths, and small limits whenever possible.",
		],
		parameters: CrawlParams,
		prepareArguments(args) {
			return coerceCommonListArguments(args, ["select_paths", "exclude_paths", "select_domains", "exclude_domains"]);
		},
		async execute(_toolCallId, params) {
			const client = createClient();
			const maxDepth = params.max_depth ?? 1;
			const limit = params.limit ?? 50;
			const extractDepth = params.extract_depth ?? "basic";
			const format = params.format ?? "markdown";
			const response = (await client.crawl(params.url, {
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
				timeout: params.timeout,
				includeUsage: true,
			})) as CrawlResponse;

			const lines: string[] = [
				`Crawled ${response.baseUrl ?? response.base_url ?? params.url}`,
				`Collected ${response.results.length} page${response.results.length === 1 ? "" : "s"}.`,
			];
			for (const [index, item] of response.results.entries()) {
				lines.push("");
				lines.push(`${index + 1}. ${item.url}`);
				if (item.favicon) lines.push(`Favicon: ${item.favicon}`);
				lines.push(coerceRawContent(item) || "(No content returned)");
				if (item.images && item.images.length > 0) {
					lines.push("");
					lines.push("Images:");
					lines.push(listLines(item.images));
				}
			}

			const built = await buildTextResult("pi-web-crawl", lines.join("\n"), response);
			return {
				content: [{ type: "text", text: built.text }],
				details: {
					url: response.baseUrl ?? response.base_url ?? params.url,
					pageCount: response.results.length,
					maxDepth,
					limit,
					extractDepth,
					format,
					requestId: getRequestId(response),
					responseTime: getResponseTime(response),
					credits: response.usage?.credits,
					fullOutputPath: built.fullOutputPath,
					truncation: built.truncation,
				} as CrawlDetails,
			};
		},
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("web_crawl "));
			text += theme.fg("accent", args.url);
			if (args.instructions) text += theme.fg("dim", " guided");
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as CrawlDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "No crawl details"), 0, 0);
			let text = theme.fg("success", `${details.pageCount} page${details.pageCount === 1 ? "" : "s"} collected`);
			text += ` ${theme.fg("muted", `from ${details.url}`)}`;
			const meta = renderMeta(details, theme);
			if (meta) text += `\n${meta}`;
			return new Text(text, 0, 0);
		},
	});
}
