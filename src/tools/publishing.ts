import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toApiError } from "../google";
import { WRITE, defineTool, fetchMedia, summarizeVideo } from "./common";

const privacyStatus = z.enum(["private", "unlisted", "public"]);
const publishAt = z
	.string()
	.optional()
	.describe("Schedule publication at this ISO date-time, e.g. '2026-10-05T15:00:00Z'. Forces privacyStatus to 'private' until then.");
const tags = z
	.array(z.string().max(100))
	.max(60)
	.optional()
	.describe("Keyword tags. YouTube allows about 500 characters in total.");

const MAX_VIDEO_BYTES = 4 * 1024 ** 3; // 4 GB
const MAX_THUMBNAIL_BYTES = 2 * 1024 ** 2; // YouTube's thumbnail limit

// Status fields YouTube sets itself and rejects if sent back.
const READ_ONLY_STATUS = ["uploadStatus", "failureReason", "rejectionReason", "madeForKids"];

export function registerPublishingTools(server: McpServer) {
	defineTool(
		server,
		"youtube_update_video",
		{
			title: "Update a video",
			description:
				"Change one of your videos' title, description, tags, category, privacy, scheduled publish time or made-for-kids setting. Only the fields you pass change; everything else is kept. Costs 51 quota units.",
			inputSchema: z.object({
				videoId: z.string(),
				title: z.string().min(1).max(100).optional(),
				description: z.string().max(5000).optional(),
				tags,
				categoryId: z.string().optional().describe("From youtube_list_categories"),
				defaultLanguage: z.string().optional().describe("ISO 639-1 code of the title/description language"),
				privacyStatus: privacyStatus.optional(),
				publishAt,
				madeForKids: z.boolean().optional(),
			}),
			annotations: WRITE,
		},
		async (args, { yt }) => {
			const current = (await yt.data("videos", { part: "snippet,status", id: args.videoId })).items?.[0];
			if (!current) throw new Error(`No video ${args.videoId} found on your channel.`);

			const snippet = {
				title: args.title ?? current.snippet.title,
				description: args.description ?? current.snippet.description,
				tags: args.tags ?? current.snippet.tags,
				categoryId: args.categoryId ?? current.snippet.categoryId,
				defaultLanguage: args.defaultLanguage ?? current.snippet.defaultLanguage,
			};
			const changesStatus = args.privacyStatus !== undefined || args.publishAt !== undefined || args.madeForKids !== undefined;
			const body: Record<string, unknown> = { id: args.videoId, snippet };
			if (changesStatus) {
				const status: Record<string, unknown> = { ...current.status };
				for (const key of READ_ONLY_STATUS) delete status[key];
				if (args.privacyStatus) status.privacyStatus = args.privacyStatus;
				if (args.publishAt) {
					status.publishAt = args.publishAt;
					status.privacyStatus = "private";
				}
				if (args.madeForKids !== undefined) status.selfDeclaredMadeForKids = args.madeForKids;
				body.status = status;
			}
			const updated = await yt.data(
				"videos",
				{ part: changesStatus ? "snippet,status" : "snippet" },
				{ method: "PUT", body: JSON.stringify(body) },
			);
			return { updated: true, video: summarizeVideo({ ...current, ...updated }) };
		},
	);

	defineTool(
		server,
		"youtube_upload_video",
		{
			title: "Upload a video",
			description: `Upload a video to your channel from a public, direct download URL (e.g. a Cloudflare R2, S3 or Dropbox direct link). Uploads as private by default so you can review it first. Costs about 100 quota units. Large files can take several minutes.
Important: until the Google Cloud project behind this server passes YouTube's API audit, YouTube locks API uploads as private. Uploading still works, but for public videos the owner must apply for the audit (see the server's README).`,
			inputSchema: z.object({
				videoUrl: z.string().url().describe("Direct download link to the video file (MP4, MOV, etc.)"),
				title: z.string().min(1).max(100),
				description: z.string().max(5000).default(""),
				tags,
				categoryId: z.string().default("22").describe("From youtube_list_categories. Default 22 = People & Blogs."),
				privacyStatus: privacyStatus.default("private"),
				publishAt,
				madeForKids: z.boolean().describe("Required by law (COPPA): is this video made for children?"),
				notifySubscribers: z.boolean().default(true),
			}),
			annotations: { ...WRITE, idempotentHint: false },
		},
		async (args, { yt }) => {
			const media = await fetchMedia(args.videoUrl, MAX_VIDEO_BYTES);
			if (!media.type.startsWith("video/") && media.type !== "application/octet-stream") {
				throw new Error(`That link serves ${media.type}, not a video file.`);
			}
			const metadata = {
				snippet: { title: args.title, description: args.description, tags: args.tags, categoryId: args.categoryId },
				status: {
					privacyStatus: args.publishAt ? "private" : args.privacyStatus,
					publishAt: args.publishAt,
					selfDeclaredMadeForKids: args.madeForKids,
				},
			};
			const session = await fetch(
				`https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${args.notifySubscribers}`,
				{
					method: "POST",
					headers: {
						Authorization: yt.authorization,
						"Content-Type": "application/json; charset=UTF-8",
						"X-Upload-Content-Type": media.type,
						"X-Upload-Content-Length": String(media.length),
					},
					body: JSON.stringify(metadata),
				},
			);
			const uploadUrl = session.headers.get("Location");
			if (!session.ok || !uploadUrl) throw toApiError(session.status, await session.json().catch(() => undefined));

			const { readable, writable } = new FixedLengthStream(media.length);
			const piping = media.body.pipeTo(writable);
			const res = await fetch(uploadUrl, {
				method: "PUT",
				headers: { Authorization: yt.authorization, "Content-Type": media.type },
				body: readable,
			});
			await piping.catch(() => undefined);
			const json: any = await res.json().catch(() => undefined);
			if (!res.ok) throw toApiError(res.status, json);
			return {
				uploaded: true,
				videoId: json.id,
				url: `https://www.youtube.com/watch?v=${json.id}`,
				studioUrl: `https://studio.youtube.com/video/${json.id}/edit`,
				privacyStatus: json.status?.privacyStatus,
				note: "YouTube is still processing the video. Set a custom thumbnail with youtube_set_thumbnail.",
			};
		},
	);

	defineTool(
		server,
		"youtube_set_thumbnail",
		{
			title: "Set a custom thumbnail",
			description:
				"Set a video's custom thumbnail from a public image URL (JPEG or PNG, 1280x720 recommended, max 2 MB). The channel must be verified (phone verification) to use custom thumbnails. Costs 50 quota units.",
			inputSchema: z.object({
				videoId: z.string(),
				imageUrl: z.string().url().describe("Direct link to a JPEG or PNG image"),
			}),
			annotations: WRITE,
		},
		async ({ videoId, imageUrl }, { yt }) => {
			const media = await fetchMedia(imageUrl, MAX_THUMBNAIL_BYTES);
			if (!["image/jpeg", "image/png"].includes(media.type)) throw new Error(`Thumbnails must be JPEG or PNG; that link serves ${media.type}.`);
			const image = await new Response(media.body).arrayBuffer();
			const res = await yt.request<any>(
				"https://www.googleapis.com/upload/youtube/v3/thumbnails/set",
				{ videoId, uploadType: "media" },
				{ method: "POST", headers: { "Content-Type": media.type }, body: image },
			);
			return { updated: true, videoId, thumbnail: res.items?.[0]?.maxres?.url ?? res.items?.[0]?.default?.url };
		},
	);

	defineTool(
		server,
		"youtube_post_comment",
		{
			title: "Post or reply to a comment",
			description:
				"Reply to a comment (pass commentId, from youtube_get_comments) or post a new top-level comment on a video (pass videoId). Posts publicly as your channel. Costs 50 quota units.",
			inputSchema: z.object({
				text: z.string().min(1).max(10000),
				commentId: z.string().optional().describe("The comment to reply to"),
				videoId: z.string().optional().describe("The video to comment on, if not replying"),
			}),
			annotations: { ...WRITE, idempotentHint: false },
		},
		async ({ text, commentId, videoId }, { yt }) => {
			if (commentId) {
				const res = await yt.data(
					"comments",
					{ part: "snippet" },
					{ method: "POST", body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } }) },
				);
				return { posted: true, commentId: res.id, inReplyTo: commentId };
			}
			if (!videoId) throw new Error("Pass commentId to reply, or videoId to post a new comment.");
			const res = await yt.data(
				"commentThreads",
				{ part: "snippet" },
				{ method: "POST", body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }) },
			);
			return { posted: true, commentId: res.snippet?.topLevelComment?.id ?? res.id, videoId };
		},
	);
}
