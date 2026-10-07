import type { CallToolResult, McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp";
import { type Props, YouTubeClient, explainError } from "../google";

export interface ToolContext {
	yt: YouTubeClient;
	props: Props;
}

function currentProps(): Props {
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props?.googleAccessToken) {
		throw new Error("Not signed in to Google. Reconnect the YouTube connector in Claude's settings.");
	}
	return props;
}

export function json(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Registers a tool whose handler gets an authenticated YouTube client and whose errors become readable tool errors. */
export function defineTool<Schema extends StandardSchemaWithJSON>(
	server: McpServer,
	name: string,
	config: { title: string; description: string; inputSchema: Schema; annotations: ToolAnnotations },
	handler: (args: StandardSchemaWithJSON.InferOutput<Schema>, ctx: ToolContext) => Promise<unknown>,
): void {
	server.registerTool(name, config, (async (args: StandardSchemaWithJSON.InferOutput<Schema>) => {
		try {
			const props = currentProps();
			const result = await handler(args, { yt: new YouTubeClient(props.googleAccessToken), props });
			return json(result);
		} catch (error) {
			return { isError: true, content: [{ type: "text", text: explainError(error) }] };
		}
	}) as never);
}

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Converts ISO 8601 durations like PT1H2M3S to seconds. */
export function durationSeconds(iso: string | undefined): number | null {
	const match = iso?.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
	if (!match) return null;
	const [, d, h, m, s] = match.map((part) => Number(part ?? 0));
	return d * 86400 + h * 3600 + m * 60 + s;
}

/** Flattens a YouTube video resource into the fields that matter for research. */
export function summarizeVideo(video: any) {
	const views = Number(video.statistics?.viewCount ?? 0);
	const likes = video.statistics?.likeCount !== undefined ? Number(video.statistics.likeCount) : null;
	const comments = video.statistics?.commentCount !== undefined ? Number(video.statistics.commentCount) : null;
	const publishedAt: string | undefined = video.snippet?.publishedAt;
	const ageDays = publishedAt ? Math.max(1, (Date.now() - Date.parse(publishedAt)) / 86_400_000) : null;
	return {
		id: video.id,
		url: `https://www.youtube.com/watch?v=${video.id}`,
		title: video.snippet?.title,
		channelId: video.snippet?.channelId,
		channelTitle: video.snippet?.channelTitle,
		publishedAt,
		durationSeconds: durationSeconds(video.contentDetails?.duration),
		views,
		likes,
		comments,
		viewsPerDay: ageDays ? Math.round(views / ageDays) : null,
		engagementRate: views > 0 && likes !== null ? Number((((likes + (comments ?? 0)) / views) * 100).toFixed(2)) : null,
		categoryId: video.snippet?.categoryId,
		tags: video.snippet?.tags ?? [],
		description: video.snippet?.description,
		thumbnail: video.snippet?.thumbnails?.maxres?.url ?? video.snippet?.thumbnails?.high?.url,
		privacyStatus: video.status?.privacyStatus,
	};
}

/** Fetches full details for up to 50 videos per call, preserving input order. */
export async function fetchVideos(yt: YouTubeClient, ids: string[], includeDescription = true) {
	const out: ReturnType<typeof summarizeVideo>[] = [];
	for (let i = 0; i < ids.length; i += 50) {
		const batch = ids.slice(i, i + 50);
		const res = await yt.data("videos", { part: "snippet,statistics,contentDetails,status", id: batch.join(",") });
		const byId = new Map<string, any>((res.items ?? []).map((item: any) => [item.id, item]));
		for (const id of batch) {
			const video = byId.get(id);
			if (!video) continue;
			const summary = summarizeVideo(video);
			if (!includeDescription) summary.description = truncate(summary.description, 200);
			out.push(summary);
		}
	}
	return out;
}

export function truncate(text: string | undefined, max: number): string | undefined {
	if (!text || text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

/** Downloads a file from a public URL, returning its stream, type and size. */
export async function fetchMedia(url: string, maxBytes: number) {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("The file URL must start with https://");
	const res = await fetch(parsed, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`Couldn't download ${url} (HTTP ${res.status}). The link must be a direct, public download link.`);
	const type = res.headers.get("Content-Type")?.split(";")[0].trim() ?? "application/octet-stream";
	if (type.startsWith("text/html")) {
		throw new Error("That link returned a web page, not a file. Use a direct download link (for Google Drive or Dropbox, use the direct-download form of the link).");
	}
	const length = Number(res.headers.get("Content-Length") ?? NaN);
	if (!Number.isFinite(length) || length <= 0) {
		throw new Error("The file host didn't report the file size, which YouTube needs. Host the file somewhere that sends Content-Length (e.g. Cloudflare R2, S3, or a Dropbox direct link).");
	}
	if (length > maxBytes) throw new Error(`The file is ${length} bytes; the limit here is ${maxBytes} bytes.`);
	return { body: res.body, type, length };
}
