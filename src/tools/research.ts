import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { YouTubeClient } from "../google";
import { READ_ONLY, defineTool, fetchVideos, truncate } from "./common";

const regionCode = z
	.string()
	.length(2)
	.optional()
	.describe("ISO 3166-1 alpha-2 country code, e.g. 'US', 'GB', 'IN'. Defaults to 'US' where a region is needed.");

async function resolveChannelId(yt: YouTubeClient, channel: string): Promise<string> {
	const value = channel.trim();
	if (/^UC[\w-]{22}$/.test(value)) return value;
	const handle = value.replace(/^https?:\/\/(www\.)?youtube\.com\//, "").replace(/\/.*$/, "");
	const res = await yt.data("channels", { part: "id", forHandle: handle.startsWith("@") ? handle : `@${handle}` });
	const id = res.items?.[0]?.id;
	if (!id) throw new Error(`No channel found for "${channel}". Pass a channel ID (UC…) or @handle.`);
	return id;
}

export function registerResearchTools(server: McpServer) {
	defineTool(
		server,
		"youtube_search",
		{
			title: "Search YouTube",
			description:
				"Search YouTube for videos, channels or playlists. Video results include views, likes, comments, views per day and engagement rate, so you can spot what's performing in a niche. Costs 100 quota units per call (of 10,000/day), so don't page through many results.",
			inputSchema: z.object({
				query: z.string().min(1).describe("Search terms, e.g. 'budget meal prep'"),
				type: z.enum(["video", "channel", "playlist"]).default("video"),
				order: z
					.enum(["relevance", "viewCount", "date", "rating"])
					.default("relevance")
					.describe("'viewCount' finds the biggest hits; 'date' finds the newest uploads"),
				publishedAfter: z
					.string()
					.optional()
					.describe("Only results published after this ISO date-time, e.g. '2026-09-01T00:00:00Z'. Combine with order=viewCount to find recent breakouts."),
				videoDuration: z.enum(["any", "short", "medium", "long"]).default("any").describe("short <4 min, medium 4-20 min, long >20 min"),
				regionCode,
				relevanceLanguage: z.string().optional().describe("ISO 639-1 language code, e.g. 'en'"),
				maxResults: z.number().int().min(1).max(50).default(15),
				pageToken: z.string().optional(),
			}),
			annotations: READ_ONLY,
		},
		async (args, { yt }) => {
			const res = await yt.data("search", {
				part: "snippet",
				q: args.query,
				type: args.type,
				order: args.order,
				publishedAfter: args.publishedAfter,
				videoDuration: args.type === "video" ? args.videoDuration : undefined,
				regionCode: args.regionCode,
				relevanceLanguage: args.relevanceLanguage,
				maxResults: args.maxResults,
				pageToken: args.pageToken,
			});
			const items: any[] = res.items ?? [];
			let results: unknown[];
			if (args.type === "video") {
				results = await fetchVideos(
					yt,
					items.map((item) => item.id.videoId).filter(Boolean),
					false,
				);
			} else {
				results = items.map((item) => ({
					id: item.id.channelId ?? item.id.playlistId,
					title: item.snippet.title,
					channelTitle: item.snippet.channelTitle,
					description: truncate(item.snippet.description, 200),
					publishedAt: item.snippet.publishedAt,
				}));
			}
			return { totalResults: res.pageInfo?.totalResults, nextPageToken: res.nextPageToken, results };
		},
	);

	defineTool(
		server,
		"youtube_get_videos",
		{
			title: "Get video details",
			description:
				"Get full details for up to 50 videos by ID: title, description, tags, duration, views, likes, comments, views per day and engagement rate. Costs 1 quota unit per 50 videos.",
			inputSchema: z.object({
				videoIds: z
					.array(z.string())
					.min(1)
					.max(50)
					.describe("Video IDs (the part after watch?v=) or full YouTube URLs"),
			}),
			annotations: READ_ONLY,
		},
		async ({ videoIds }, { yt }) => {
			const ids = videoIds.map((id) => {
				const match = id.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/);
				return match ? match[1] : id.trim();
			});
			return { videos: await fetchVideos(yt, ids) };
		},
	);

	defineTool(
		server,
		"youtube_trending",
		{
			title: "Trending videos",
			description: "List the videos currently trending (YouTube's 'most popular' chart) in a country, optionally within one category. Costs 1 quota unit.",
			inputSchema: z.object({
				regionCode,
				videoCategoryId: z.string().optional().describe("Category ID from youtube_list_categories, e.g. '10' Music, '20' Gaming, '24' Entertainment, '28' Science & Technology"),
				maxResults: z.number().int().min(1).max(50).default(25),
				pageToken: z.string().optional(),
			}),
			annotations: READ_ONLY,
		},
		async (args, { yt }) => {
			const res = await yt.data("videos", {
				part: "id",
				chart: "mostPopular",
				regionCode: args.regionCode ?? "US",
				videoCategoryId: args.videoCategoryId,
				maxResults: args.maxResults,
				pageToken: args.pageToken,
			});
			const videos = await fetchVideos(yt, (res.items ?? []).map((item: any) => item.id), false);
			return { nextPageToken: res.nextPageToken, videos };
		},
	);

	defineTool(
		server,
		"youtube_get_channel",
		{
			title: "Get channel details",
			description:
				"Get a channel's subscribers, total views, video count, description and keywords. Pass a channel ID (UC…), an @handle, or omit it for your own channel. Costs 1 quota unit.",
			inputSchema: z.object({
				channel: z.string().optional().describe("Channel ID, @handle or channel URL. Omit for your own channel."),
			}),
			annotations: READ_ONLY,
		},
		async ({ channel }, { yt }) => {
			const query = channel ? { id: await resolveChannelId(yt, channel) } : { mine: true };
			const res = await yt.data("channels", { part: "snippet,statistics,brandingSettings,contentDetails,status", ...query });
			const item = res.items?.[0];
			if (!item) throw new Error(channel ? `No channel found for "${channel}".` : "Your Google account has no YouTube channel yet.");
			const subs = item.statistics.hiddenSubscriberCount ? null : Number(item.statistics.subscriberCount);
			const views = Number(item.statistics.viewCount);
			const videos = Number(item.statistics.videoCount);
			return {
				id: item.id,
				url: `https://www.youtube.com/channel/${item.id}`,
				handle: item.snippet.customUrl,
				title: item.snippet.title,
				description: item.snippet.description,
				country: item.snippet.country,
				createdAt: item.snippet.publishedAt,
				subscribers: subs,
				totalViews: views,
				videoCount: videos,
				averageViewsPerVideo: videos > 0 ? Math.round(views / videos) : null,
				keywords: item.brandingSettings?.channel?.keywords,
				uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
				madeForKids: item.status?.madeForKids,
			};
		},
	);

	defineTool(
		server,
		"youtube_list_channel_videos",
		{
			title: "List a channel's videos",
			description:
				"List a channel's most recent uploads with full stats, optionally re-sorted by views or engagement to see what works best for them. Omit the channel for your own. Costs about 2 quota units per 50 videos.",
			inputSchema: z.object({
				channel: z.string().optional().describe("Channel ID, @handle or channel URL. Omit for your own channel."),
				maxResults: z.number().int().min(1).max(200).default(50).describe("How many of the most recent uploads to fetch"),
				sortBy: z.enum(["date", "views", "viewsPerDay", "engagementRate"]).default("date"),
			}),
			annotations: READ_ONLY,
		},
		async ({ channel, maxResults, sortBy }, { yt }) => {
			const query = channel ? { id: await resolveChannelId(yt, channel) } : { mine: true };
			const ch = await yt.data("channels", { part: "contentDetails,snippet", ...query });
			const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
			if (!uploads) throw new Error("Couldn't find that channel's uploads.");
			const ids: string[] = [];
			let pageToken: string | undefined;
			do {
				const page = await yt.data("playlistItems", {
					part: "contentDetails",
					playlistId: uploads,
					maxResults: Math.min(50, maxResults - ids.length),
					pageToken,
				});
				ids.push(...(page.items ?? []).map((item: any) => item.contentDetails.videoId));
				pageToken = page.nextPageToken;
			} while (pageToken && ids.length < maxResults);
			const videos = await fetchVideos(yt, ids, false);
			const key = { date: null, views: "views", viewsPerDay: "viewsPerDay", engagementRate: "engagementRate" }[sortBy] as
				| "views"
				| "viewsPerDay"
				| "engagementRate"
				| null;
			if (key) videos.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0));
			return { channelId: ch.items[0].id, channelTitle: ch.items[0].snippet.title, count: videos.length, videos };
		},
	);

	defineTool(
		server,
		"youtube_get_comments",
		{
			title: "Get comments",
			description:
				"Read top-level comments (with reply counts) on a video, or across all of your channel's videos. Useful for finding audience questions, video ideas and comments worth replying to. Costs 1 quota unit per page.",
			inputSchema: z.object({
				videoId: z.string().optional().describe("Video ID. Omit to read recent comments across your whole channel."),
				order: z.enum(["relevance", "time"]).default("relevance"),
				searchTerms: z.string().optional().describe("Only return comments containing these words"),
				maxResults: z.number().int().min(1).max(100).default(50),
				pageToken: z.string().optional(),
			}),
			annotations: READ_ONLY,
		},
		async (args, { yt, props }) => {
			if (!args.videoId && !props.channelId) throw new Error("Your Google account has no YouTube channel, so pass a videoId.");
			const res = await yt.data("commentThreads", {
				part: "snippet",
				videoId: args.videoId,
				allThreadsRelatedToChannelId: args.videoId ? undefined : props.channelId!,
				order: args.order,
				searchTerms: args.searchTerms,
				maxResults: args.maxResults,
				pageToken: args.pageToken,
				textFormat: "plainText",
			});
			return {
				nextPageToken: res.nextPageToken,
				comments: (res.items ?? []).map((thread: any) => {
					const top = thread.snippet.topLevelComment;
					return {
						commentId: top.id,
						videoId: thread.snippet.videoId,
						author: top.snippet.authorDisplayName,
						text: top.snippet.textDisplay,
						likes: top.snippet.likeCount,
						replies: thread.snippet.totalReplyCount,
						publishedAt: top.snippet.publishedAt,
					};
				}),
			};
		},
	);

	defineTool(
		server,
		"youtube_list_categories",
		{
			title: "List video categories",
			description: "List the video category IDs and names available in a country, for filtering trending videos or setting a video's category.",
			inputSchema: z.object({ regionCode }),
			annotations: READ_ONLY,
		},
		async ({ regionCode }, { yt }) => {
			const res = await yt.data("videoCategories", { part: "snippet", regionCode: regionCode ?? "US" });
			return (res.items ?? [])
				.filter((item: any) => item.snippet.assignable)
				.map((item: any) => ({ id: item.id, title: item.snippet.title }));
		},
	);
}
