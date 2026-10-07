import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type YouTubeClient, explainError } from "../google";
import { READ_ONLY, defineTool } from "./common";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function isoDay(offsetDays: number): string {
	return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Turns an Analytics API report into an array of row objects. */
function rowsOf(report: any): Record<string, string | number>[] {
	const names: string[] = (report?.columnHeaders ?? []).map((header: any) => header.name);
	return (report?.rows ?? []).map((row: unknown[]) => Object.fromEntries(names.map((name, i) => [name, row[i] as string | number])));
}

async function report(yt: YouTubeClient, query: Record<string, string | number | undefined>) {
	return rowsOf(await yt.analytics({ ids: "channel==MINE", currency: "USD", ...query }));
}

const REVENUE_METRICS = "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,grossRevenue,cpm,playbackBasedCpm,monetizedPlaybacks";

export function registerAnalyticsTools(server: McpServer) {
	defineTool(
		server,
		"youtube_channel_performance",
		{
			title: "Channel performance summary",
			description:
				"Summarize your channel over a date range: views, watch time, subscribers gained and lost, engagement, estimated revenue and RPM/CPM (if the channel is in the YouTube Partner Program), top videos, and traffic sources. Analytics lag 2-3 days behind today. Start here when asked how the channel or its earnings are doing.",
			inputSchema: z.object({
				days: z.number().int().min(1).max(3650).default(28).describe("Length of the period, ending 3 days ago. Ignored if startDate/endDate are set."),
				startDate: date.optional(),
				endDate: date.optional(),
				topVideos: z.number().int().min(1).max(50).default(10),
			}),
			annotations: READ_ONLY,
		},
		async (args, { yt, props }) => {
			const endDate = args.endDate ?? isoDay(-3);
			const startDate = args.startDate ?? new Date(Date.parse(endDate) - (args.days - 1) * 86_400_000).toISOString().slice(0, 10);
			const range = { startDate, endDate };

			const [totals] = await report(yt, {
				...range,
				metrics:
					"views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares",
			});

			let revenue: Record<string, string | number> | { unavailable: string };
			let revenueByVideo = false;
			try {
				const [row] = await report(yt, { ...range, metrics: REVENUE_METRICS });
				revenue = row ?? {};
				const views = Number(totals?.views ?? 0);
				if (row && views > 0) revenue.rpm = Number(((Number(row.estimatedRevenue) / views) * 1000).toFixed(2));
				revenueByVideo = true;
			} catch (error) {
				revenue = {
					unavailable: `Revenue isn't available: ${explainError(error)} This is normal if the channel isn't in the YouTube Partner Program yet.`,
				};
			}

			const top = await report(yt, {
				...range,
				dimensions: "video",
				metrics: `views,estimatedMinutesWatched,averageViewPercentage,subscribersGained${revenueByVideo ? ",estimatedRevenue" : ""}`,
				sort: "-views",
				maxResults: args.topVideos,
			});
			const titles = new Map<string, string>();
			if (top.length > 0) {
				const res = await yt.data("videos", { part: "snippet", id: top.map((row) => row.video).join(",") });
				for (const item of res.items ?? []) titles.set(item.id, item.snippet.title);
			}

			const traffic = await report(yt, {
				...range,
				dimensions: "insightTrafficSourceType",
				metrics: "views,estimatedMinutesWatched",
				sort: "-views",
			});

			return {
				channel: props.channelTitle,
				period: range,
				totals: totals ?? {},
				netSubscribers: totals ? Number(totals.subscribersGained) - Number(totals.subscribersLost) : 0,
				revenueUSD: revenue,
				topVideos: top.map((row) => ({ title: titles.get(String(row.video)), ...row })),
				trafficSources: traffic,
			};
		},
	);

	defineTool(
		server,
		"youtube_analytics_report",
		{
			title: "Custom analytics report",
			description: `Run any YouTube Analytics API report for your channel. Examples:
- Daily views and revenue: metrics='views,estimatedRevenue', dimensions='day', sort='day'
- Top videos by revenue: metrics='estimatedRevenue,views,cpm', dimensions='video', sort='-estimatedRevenue', maxResults=25
- Audience by country: metrics='views,estimatedMinutesWatched', dimensions='country', sort='-views'
- Age/gender: metrics='viewerPercentage', dimensions='ageGroup,gender'
- One video over time: metrics='views,averageViewPercentage', dimensions='day', filters='video==VIDEO_ID'
- Search terms that found you: metrics='views', dimensions='insightTrafficSourceDetail', filters='insightTrafficSourceType==YT_SEARCH', sort='-views', maxResults=25
Revenue metrics (estimatedRevenue, estimatedAdRevenue, grossRevenue, cpm, playbackBasedCpm, monetizedPlaybacks) need a monetized channel. Data lags 2-3 days.`,
			inputSchema: z.object({
				startDate: date,
				endDate: date,
				metrics: z.string().describe("Comma-separated metrics, e.g. 'views,estimatedMinutesWatched,estimatedRevenue'"),
				dimensions: z.string().optional().describe("Comma-separated dimensions, e.g. 'day', 'video', 'country'"),
				filters: z.string().optional().describe("e.g. 'video==abc123XYZ00' or 'country==US'"),
				sort: z.string().optional().describe("Metric or dimension to sort by; prefix '-' for descending"),
				maxResults: z.number().int().min(1).max(200).optional(),
			}),
			annotations: READ_ONLY,
		},
		async (args, { yt }) => ({ rows: await report(yt, { ...args }) }),
	);
}
