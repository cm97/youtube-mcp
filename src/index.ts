import OAuthProvider, { OAuthError, type TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp";
import { authHandler } from "./auth";
import { type Env, GoogleTokenError, type Props, refreshGoogleToken } from "./google";
import { registerAnalyticsTools } from "./tools/analytics";
import { registerPublishingTools } from "./tools/publishing";
import { registerResearchTools } from "./tools/research";

const mcpHandler = createMcpHandler(
	() => {
		const server = new McpServer(
			{ name: "youtube-mcp", version: "0.1.0" },
			{
				instructions:
					"Tools for growing and monetizing a YouTube channel. Research: youtube_search, youtube_trending, youtube_get_videos, youtube_get_channel, youtube_list_channel_videos, youtube_get_comments. Earnings and performance: start with youtube_channel_performance, then youtube_analytics_report for detail. Publishing: youtube_update_video, youtube_upload_video, youtube_set_thumbnail, youtube_post_comment. Confirm with the user before any tool that changes their channel. The API quota is 10,000 units a day and a search costs 100, so prefer the cheaper tools when you already know IDs.",
			},
		);
		registerResearchTools(server);
		registerAnalyticsTools(server);
		registerPublishingTools(server);
		return server;
	},
	{ route: "/mcp" },
);

// Keep MCP access tokens a minute shorter than Google's, so Claude refreshes (and we refresh Google) before Google's token lapses.
const secondsLeft = (expiresAt: number) => Math.max(60, expiresAt - Math.floor(Date.now() / 1000) - 60);

async function tokenExchangeCallback({ grantType, props, env }: TokenExchangeCallbackOptions<Env>) {
	const current = props as Props;
	if (grantType === "authorization_code") {
		return { accessTokenTTL: secondsLeft(current.googleExpiresAt) };
	}
	if (grantType !== "refresh_token") return;
	try {
		const tokens = await refreshGoogleToken(env, current.googleRefreshToken);
		const next: Props = {
			...current,
			googleAccessToken: tokens.access_token,
			googleRefreshToken: tokens.refresh_token ?? current.googleRefreshToken,
			googleExpiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
		};
		return { newProps: next, accessTokenTTL: secondsLeft(next.googleExpiresAt) };
	} catch (error) {
		if (error instanceof GoogleTokenError && error.code === "invalid_grant") {
			throw new OAuthError("invalid_grant", { description: "Google access was revoked or expired. Reconnect to continue." });
		}
		throw new OAuthError("temporarily_unavailable", { description: "Couldn't reach Google. Try again shortly.", statusCode: 503 });
	}
}

// The provider needs this deployment's absolute URL, which we only learn from the first request, so build one per origin.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: { fetch: mcpHandler as ExportedHandlerFetchHandler<Env> },
			defaultHandler: authHandler as ExportedHandler<Env>,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			clientIdMetadataDocumentEnabled: true,
			resourceMetadata: { resource: `${origin}/mcp`, resource_name: "YouTube" },
			tokenExchangeCallback,
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request, env, ctx) {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
