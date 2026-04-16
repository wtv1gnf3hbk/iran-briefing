/**
 * iran-briefing-cron — Cloudflare Worker
 *
 * Workaround for GitHub Actions schedule-event throttling on public repos.
 * GitHub silently dropped most of our `*\/5 * * * *` cron events (observed
 * 60-130 min gaps instead of 5 min). workflow_dispatch events are NOT
 * throttled the same way, so this Worker fires a dispatch every minute
 * via Cloudflare's reliable cron triggers.
 *
 * Endpoints:
 *   GET  /         — info page
 *   POST /refresh  — manual workflow_dispatch trigger (mirrors briefing-refresh-worker)
 *   GET  /health   — Worker health check, no GitHub call
 *
 * Cron:
 *   Triggered by Cloudflare every 1 min (see wrangler.toml [triggers] crons)
 *
 * Required Worker secrets (set via `npx wrangler secret put GITHUB_PAT`):
 *   GITHUB_PAT — GitHub personal access token with `actions:write` scope
 *                on the iran-briefing repo
 *
 * Worker vars (set in wrangler.toml):
 *   REPO_OWNER, REPO_NAME, WORKFLOW_FILE
 */

export default {
  // -------- CRON: Cloudflare scheduler fires this --------
  async scheduled(event, env, ctx) {
    // Run dispatch as a non-blocking task; Workers gives scheduled handlers
    // up to 30s of execution time, plenty for one HTTP call.
    ctx.waitUntil(dispatchWorkflow(env, 'cron').catch((e) => {
      console.error('[cron] dispatch failed:', e.message);
    }));
  },

  // -------- HTTP: manual triggers + health --------
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        time: new Date().toISOString(),
        worker: 'iran-briefing-cron',
      }), { headers: cors });
    }

    if (url.pathname === '/refresh') {
      const result = await dispatchWorkflow(env, 'manual');
      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 500,
        headers: cors,
      });
    }

    // Default: human-readable info
    return new Response(
      'iran-briefing-cron\n\n' +
      'Triggers ' + env.REPO_OWNER + '/' + env.REPO_NAME + ' workflow_dispatch every minute.\n' +
      'Endpoints: GET /health, POST /refresh\n',
      { status: 200, headers: { 'Content-Type': 'text/plain' } }
    );
  },
};

/**
 * Fire a workflow_dispatch on the configured GitHub repo + workflow file.
 * Returns {success, status, source, time} or {success: false, error}.
 */
async function dispatchWorkflow(env, source) {
  const startedAt = new Date().toISOString();

  if (!env.GITHUB_PAT) {
    return { success: false, source, error: 'GITHUB_PAT secret not set' };
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${env.REPO_OWNER}/${env.REPO_NAME}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${env.GITHUB_PAT}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'iran-briefing-cron',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    // 204 No Content = success per GitHub Actions API
    if (response.status === 204) {
      console.log(`[${source}] dispatched at ${startedAt}`);
      return { success: true, source, status: 204, time: startedAt };
    }

    const errorText = await response.text();
    console.error(`[${source}] dispatch failed: ${response.status} - ${errorText}`);
    return {
      success: false,
      source,
      status: response.status,
      error: errorText,
      time: startedAt,
    };
  } catch (err) {
    console.error(`[${source}] exception: ${err.message}`);
    return { success: false, source, error: err.message, time: startedAt };
  }
}
