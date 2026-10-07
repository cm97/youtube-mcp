// The authorization pages: consent, the hand-off to Google, and Google's callback.

import {
	AuthorizationError,
	CimdFetchError,
	authorizationErrorRedirect,
	type ConsentDescription,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
	type Env,
	type Props,
	YouTubeClient,
	exchangeGoogleCode,
	googleAuthorizeUrl,
	googleUserEmail,
	s256,
} from "./google";

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers = new Headers()): Response {
	headers.set("Content-Type", "text/html; charset=utf-8");
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#161616}code{background:#2a2a2a}}
button{font:inherit;padding:.5rem 1.1rem;border-radius:.4rem;border:1px solid #888;cursor:pointer;margin-right:.5rem}
button[value=approve]{background:#c00;color:#fff;border-color:#c00}
code{background:#f1f1f1;padding:.1rem .3rem;border-radius:.2rem}
.warn{border-left:4px solid #e0a800;padding-left:.8rem}
</style></head><body>${body}</body></html>`;
	return new Response(html, { status, headers });
}

function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
	const name = escape(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escape(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name is not verified.";
	return page(
		`Connect ${details.clientName} to YouTube`,
		`<h1>Allow ${name} to use your YouTube channel?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${
	details.redirectIsLoopback
		? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>'
		: ""
}
<p>If you allow it, you'll sign in with Google next. The app will be able to search YouTube, read your channel analytics and revenue, edit and upload videos, set thumbnails and reply to comments.</p>
<form method="post">
<input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Continue to Google</button><button name="decision" value="deny">Cancel</button>
</form>`,
		200,
		headers,
	);
}

function errorPage(message: string, status = 400): Response {
	return page("Can't connect", `<h1>Can't connect</h1><p>${escape(message)}</p>`, status);
}

async function authorize(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	if (request.method === "GET") {
		const authRequest = await oauth.parseAuthRequest(request);
		const details = await oauth.describeConsent(authRequest);
		const consent = await oauth.beginConsent(authRequest);
		return consentPage(details, consent.handle, consent.headers);
	}

	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(request, handle);
	const verifier = crypto.randomUUID() + crypto.randomUUID();
	const { state, headers } = await oauth.beginUpstream(approved.request, {
		data: { verifier },
		headers: approved.headers,
	});
	headers.set(
		"Location",
		googleAuthorizeUrl({
			clientId: env.GOOGLE_CLIENT_ID,
			redirectUri: new URL("/callback", request.url).href,
			state,
			codeChallenge: await s256(verifier),
		}),
	);
	return new Response(null, { status: 302, headers });
}

async function callback(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const url = new URL(request.url);
	const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);

	const code = url.searchParams.get("code");
	if (url.searchParams.get("error") || !code) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	const tokens = await exchangeGoogleCode(env, code, data.verifier, new URL("/callback", request.url).href);
	if (!tokens.refresh_token) {
		return errorPage("Google didn't return a refresh token. Remove this app at myaccount.google.com/permissions and try again.");
	}
	const granted = new Set((tokens.scope ?? "").split(" "));
	const missing = ["youtube.force-ssl", "yt-analytics.readonly"].filter(
		(scope) => !granted.has(`https://www.googleapis.com/auth/${scope}`),
	);
	if (missing.length > 0) {
		return errorPage("Some YouTube permissions weren't granted. Start again and tick every box on Google's consent screen.");
	}

	const email = await googleUserEmail(tokens.access_token);
	const allowed = (env.ALLOWED_GOOGLE_EMAILS ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
	if (allowed.length > 0 && !allowed.includes(email)) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}

	const channels = await new YouTubeClient(tokens.access_token).data<{ items?: { id: string; snippet: { title: string } }[] }>(
		"channels",
		{ part: "snippet", mine: true },
	);
	const channel = channels.items?.[0];

	const props: Props = {
		email,
		channelId: channel?.id ?? null,
		channelTitle: channel?.snippet.title ?? null,
		googleAccessToken: tokens.access_token,
		googleRefreshToken: tokens.refresh_token,
		googleExpiresAt: Math.floor(Date.now() / 1000) + tokens.expires_in,
	};
	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: email,
		metadata: { channelTitle: props.channelTitle },
		scope: original.scope,
		props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

function home(request: Request): Response {
	const mcpUrl = new URL("/mcp", request.url).href;
	return page(
		"YouTube MCP",
		`<h1>YouTube MCP server</h1>
<p>This server is running. To use it, add it to Claude as a custom connector with this URL:</p>
<p><code>${escape(mcpUrl)}</code></p>`,
	);
}

export const authHandler: ExportedHandler<AuthEnv> = {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) {
				return await authorize(request, env);
			}
			if (pathname === "/callback" && request.method === "GET") return await callback(request, env);
			if (pathname === "/" && request.method === "GET") return home(request);
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
			if (error instanceof AuthorizationError) return errorPage(`${error.description ?? error.message} Please start again from Claude.`);
			if (error instanceof CimdFetchError) return errorPage("This app could not be verified.");
			throw error;
		}
	},
};
