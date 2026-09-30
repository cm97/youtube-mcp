# youtube-mcp

A remote [MCP](https://modelcontextprotocol.io) server that connects Claude to your YouTube channel. It runs on Cloudflare Workers, and you sign in with your Google account.

## What Claude can do with it

| Area | Tools |
| --- | --- |
| **Research** | `youtube_search` (videos with views/day and engagement rate), `youtube_trending`, `youtube_get_videos`, `youtube_get_channel`, `youtube_list_channel_videos` (sort a competitor's uploads by views), `youtube_get_comments`, `youtube_list_categories` |
| **Analytics & revenue** | `youtube_channel_performance` (views, watch time, subscribers, estimated revenue, RPM/CPM, top videos, traffic sources), `youtube_analytics_report` (any YouTube Analytics query) |
| **Publishing** | `youtube_update_video` (titles, descriptions, tags, privacy, scheduling), `youtube_upload_video`, `youtube_set_thumbnail`, `youtube_post_comment` |

Example prompts once it's connected:

- "How much did my channel earn in the last 28 days, and which videos made the most?"
- "Find the most-viewed videos about budget meal prep from the last 30 days and tell me what their titles have in common."
- "Look at @SomeCompetitor's top 20 videos by views and suggest 10 video ideas for my channel."
- "Rewrite the title, description and tags of my 5 lowest-performing videos from this year to improve search traffic. Show me the changes before applying them."
- "Which search terms bring people to my channel?"
- "Reply to unanswered questions in the comments on my latest video."

## Setup (about 20 minutes, one time)

You need a Google account that owns the YouTube channel and a free Cloudflare account.

### 1. Deploy the server to Cloudflare

```sh
git clone https://github.com/cm97/youtube-mcp && cd youtube-mcp
npm install
npx wrangler login     # opens a browser to sign in to Cloudflare
npx wrangler deploy    # also creates the KV storage it needs
```

The deploy prints your server's address, something like `https://youtube-mcp.<your-subdomain>.workers.dev`. You'll need it below.

### 2. Create Google API credentials

In the [Google Cloud console](https://console.cloud.google.com/):

1. **Create a project** (top bar → project picker → *New project*), e.g. "YouTube MCP".
2. **Turn on the APIs.** Go to *APIs & Services → Library* and enable **YouTube Data API v3** and **YouTube Analytics API**.
3. **Set up the consent screen.** Go to *APIs & Services → OAuth consent screen* (or *Google Auth Platform*):
   - User type: **External**. App name: anything, e.g. "YouTube MCP". Support email: yours.
   - On **Audience**, add your own Gmail address as a **test user**.
4. **Create the OAuth client.** Go to *APIs & Services → Credentials → Create credentials → OAuth client ID*:
   - Application type: **Web application**
   - Authorized redirect URI: `https://youtube-mcp.<your-subdomain>.workers.dev/callback` (your address from step 1, plus `/callback`)
   - Copy the **Client ID** and **Client secret**.

### 3. Give the server its secrets

```sh
npx wrangler secret put GOOGLE_CLIENT_ID        # paste the client ID
npx wrangler secret put GOOGLE_CLIENT_SECRET    # paste the client secret
npx wrangler secret put ALLOWED_GOOGLE_EMAILS   # your Gmail address; only this account can connect
```

### 4. Connect it to Claude

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Name: `YouTube`. URL: `https://youtube-mcp.<your-subdomain>.workers.dev/mcp`
3. Click **Connect**. Approve the page that opens, sign in with Google, and **tick every permission box**. Google will say the app isn't verified. That's expected for your own private app, so click *Continue*.

Then turn the connector on in a chat and try one of the prompts above.

## Limits to know about

- **Weekly reconnect while in Testing mode.** Google expires sign-ins for apps in "Testing" after 7 days. To avoid that, go to the OAuth consent screen and click **Publish app** (*In production*). You don't need Google's verification for your own use; you'll just keep seeing the "unverified app" warning when you connect. Keep `ALLOWED_GOOGLE_EMAILS` set so nobody else can use your server.
- **Uploads are private until an audit.** YouTube locks videos uploaded through a new, unaudited API project as private. Everything else works right away. To publish uploads publicly through the API, apply for the [YouTube API compliance audit](https://support.google.com/youtube/contact/yt_api_form). Until then, upload through YouTube Studio and use this server for everything else.
- **Revenue data needs the YouTube Partner Program.** If the channel isn't monetized yet, the revenue fields report as unavailable, and all other analytics still work.
- **Daily quota: 10,000 units.** A search costs 100 units, a video edit about 50, and most reads cost 1. That's plenty for everyday use. Each tool's description lists its cost. You can request more quota in the Google Cloud console.
- **Custom thumbnails** need a phone-verified channel.
- **Video uploads** come from a public, direct download link (e.g. Cloudflare R2, S3, or a Dropbox link ending in `?dl=1`), up to 4 GB.

## Development

```sh
cp .dev.vars.example .dev.vars   # fill in the Google credentials
npm run dev                      # http://localhost:8787 (add http://localhost:8787/callback as a redirect URI in Google)
npm run typecheck
```

How it works: `src/index.ts` wraps the MCP endpoint (`/mcp`) in [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), which handles Claude's OAuth (dynamic client registration, PKCE, tokens). `src/auth.ts` shows a consent page and then hands off to Google sign-in. Google tokens are stored encrypted in the grant and refreshed whenever Claude refreshes its token. The tools live in `src/tools/`.
