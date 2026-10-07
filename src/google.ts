// Google OAuth and YouTube API helpers.

export interface Env {
	OAUTH_KV: KVNamespace;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	/** Optional comma-separated list of Google accounts allowed to connect. */
	ALLOWED_GOOGLE_EMAILS?: string;
}

/** What each MCP grant carries (encrypted at rest by the OAuth provider). */
export interface Props extends Record<string, unknown> {
	email: string;
	channelId: string | null;
	channelTitle: string | null;
	googleAccessToken: string;
	googleRefreshToken: string;
	/** Epoch seconds when googleAccessToken expires. */
	googleExpiresAt: number;
}

export const GOOGLE_SCOPES = [
	"openid",
	"email",
	// Read and manage videos, playlists, comments and thumbnails.
	"https://www.googleapis.com/auth/youtube.force-ssl",
	"https://www.googleapis.com/auth/youtube.upload",
	// Channel analytics, including revenue for monetized channels.
	"https://www.googleapis.com/auth/yt-analytics.readonly",
	"https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

export function googleAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.search = new URLSearchParams({
		client_id: opts.clientId,
		redirect_uri: opts.redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPES.join(" "),
		access_type: "offline",
		// Always ask, so Google returns a refresh token on every connect.
		prompt: "consent",
		include_granted_scopes: "true",
		state: opts.state,
		code_challenge: opts.codeChallenge,
		code_challenge_method: "S256",
	}).toString();
	return url.toString();
}

interface GoogleTokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
	id_token?: string;
}

export class GoogleTokenError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

async function tokenRequest(body: Record<string, string>): Promise<GoogleTokenResponse> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body),
	});
	const json = (await res.json().catch(() => ({}))) as Partial<GoogleTokenResponse> & {
		error?: string;
		error_description?: string;
	};
	if (!res.ok || !json.access_token) {
		throw new GoogleTokenError(
			json.error ?? `http_${res.status}`,
			json.error_description ?? json.error ?? `Google token endpoint returned ${res.status}`,
		);
	}
	return json as GoogleTokenResponse;
}

export function exchangeGoogleCode(
	env: Env,
	code: string,
	verifier: string,
	redirectUri: string,
): Promise<GoogleTokenResponse> {
	return tokenRequest({
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		code,
		code_verifier: verifier,
		grant_type: "authorization_code",
		redirect_uri: redirectUri,
	});
}

export function refreshGoogleToken(env: Env, refreshToken: string): Promise<GoogleTokenResponse> {
	return tokenRequest({
		client_id: env.GOOGLE_CLIENT_ID,
		client_secret: env.GOOGLE_CLIENT_SECRET,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	});
}

export async function googleUserEmail(accessToken: string): Promise<string> {
	const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Could not read Google profile (${res.status})`);
	const json = (await res.json()) as { email?: string; email_verified?: boolean };
	if (!json.email || json.email_verified === false) throw new Error("Google account has no verified email");
	return json.email.toLowerCase();
}

export async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// YouTube REST client

export class YouTubeApiError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string | undefined,
		message: string,
	) {
		super(message);
	}
}

type Query = Record<string, string | number | boolean | undefined>;

export class YouTubeClient {
	constructor(private readonly accessToken: string) {}

	get authorization(): string {
		return `Bearer ${this.accessToken}`;
	}

	data<T = any>(path: string, query: Query = {}, init: RequestInit = {}): Promise<T> {
		return this.request(`https://www.googleapis.com/youtube/v3/${path}`, query, init);
	}

	analytics<T = any>(query: Query): Promise<T> {
		return this.request("https://youtubeanalytics.googleapis.com/v2/reports", query);
	}

	async request<T>(base: string, query: Query, init: RequestInit = {}): Promise<T> {
		const url = new URL(base);
		for (const [key, value] of Object.entries(query)) {
			if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
		}
		const headers = new Headers(init.headers);
		headers.set("Authorization", this.authorization);
		if (init.body && typeof init.body === "string" && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		const res = await fetch(url, { ...init, headers });
		if (res.status === 204) return undefined as T;
		const text = await res.text();
		const json = text ? JSON.parse(text) : undefined;
		if (!res.ok) throw toApiError(res.status, json);
		return json as T;
	}
}

export function toApiError(status: number, json: any): YouTubeApiError {
	const err = json?.error;
	const reason: string | undefined = err?.errors?.[0]?.reason ?? err?.status;
	return new YouTubeApiError(status, reason, err?.message ?? `YouTube API returned HTTP ${status}`);
}

/** Turns an API failure into advice the model can act on. */
export function explainError(error: unknown): string {
	if (error instanceof YouTubeApiError) {
		const hints: Record<string, string> = {
			quotaExceeded:
				"The daily YouTube API quota (10,000 units by default) is used up. It resets at midnight Pacific time. Searches cost 100 units each, so prefer youtube_get_videos / youtube_list_channel_videos when you already know IDs.",
			forbidden: "The connected Google account isn't allowed to do this (for example, editing a video on a channel it doesn't own).",
			insufficientPermissions:
				"The connection is missing a Google permission. Disconnect and reconnect the connector in Claude, and tick every box on Google's consent screen.",
			ACCESS_TOKEN_SCOPE_INSUFFICIENT:
				"The connection is missing a Google permission. Disconnect and reconnect the connector in Claude, and tick every box on Google's consent screen.",
			videoNotFound: "No video with that ID exists, or it's private to another channel.",
			channelNotFound: "No channel matched. Check the ID or @handle.",
			commentsDisabled: "Comments are turned off for this video.",
			uploadLimitExceeded: "The channel has hit YouTube's upload limit for now. Try again later.",
		};
		const hint = (error.reason && hints[error.reason]) ?? "";
		if (error.status === 401) {
			return "Google rejected the access token. Disconnect and reconnect the YouTube connector in Claude's settings.";
		}
		return `YouTube API error ${error.status}${error.reason ? ` (${error.reason})` : ""}: ${error.message}${hint ? `\n${hint}` : ""}`;
	}
	return error instanceof Error ? error.message : String(error);
}
