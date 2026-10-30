// The site's only server code: the Team plan waitlist at POST /api/waitlist.
// Every other request is a static file from site/, served by Workers assets
// before this script runs (wrangler.jsonc routes only /api/* here).
//
// The form posts as a plain HTML form, so it works without JavaScript and from
// the GitHub Pages mirror. Each sign-up is one KV entry keyed by the lowercased
// email, so signing up twice updates the entry instead of adding a second one.
//
// Read the list with:
//   npx wrangler kv key list --binding WAITLIST --remote
//   npx wrangler kv key get --binding WAITLIST --remote "signup:you@company.com"

const TEAM_SIZES = new Set(['1', '2-5', '6-20', '21+']);
const AGENTS = new Set(['claude', 'codex', 'opencode', 'other']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY = 8 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/waitlist') return waitlist(request, env);
    return env.ASSETS.fetch(request);
  },
};

export async function waitlist(request, env, now = new Date()) {
  if (request.method !== 'POST') {
    return page(405, 'Use the form', 'This address takes the waitlist form. Open the home page to sign up.', {Allow: 'POST'});
  }
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) {
    return page(413, 'That was too long', 'Shorten what you wrote and try again.');
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    return page(400, 'That did not arrive', 'The form could not be read. Go back and try again.');
  }

  // A filled honeypot is a bot. Answer as if it worked so it learns nothing.
  if (String(form.get('website') ?? '').trim()) return page(200, 'You are on the list', thanks);

  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    return page(400, 'Check your email', 'That email address does not look complete. Go back and try again.');
  }
  const teamSize = String(form.get('team_size') ?? '');
  const agents = [...new Set(form.getAll('agents').map(String))].filter(agent => AGENTS.has(agent));
  const entry = {
    email,
    team_size: TEAM_SIZES.has(teamSize) ? teamSize : null,
    agents,
    need: String(form.get('need') ?? '').trim().slice(0, 1000),
    joined: now.toISOString(),
  };

  const key = `signup:${email}`;
  const previous = await env.WAITLIST.get(key, 'json');
  if (previous?.joined) entry.joined = previous.joined;
  if (previous) entry.updated = now.toISOString();
  await env.WAITLIST.put(key, JSON.stringify(entry));
  return page(200, 'You are on the list', thanks);
}

const thanks = 'Thank you. We will write only about the Team plan, and you can ask us to delete your entry at any time.';

const escape = text => text.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

// A small page in the site's own style. Root-relative paths are fine here: this
// response only ever comes from the canonical origin, never the Pages mirror.
function page(status, title, body, headers = {}) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · Agent Relay</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main id="main" class="wrap" style="min-height:100vh;display:grid;place-content:center;text-align:center;gap:18px">
<h1 style="font-size:clamp(28px,5vw,48px);letter-spacing:-.04em">${escape(title)}</h1>
<p style="color:var(--muted);max-width:52ch;margin:0 auto">${escape(body)}</p>
<p><a class="cta" href="/">Back to Agent Relay</a></p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers},
  });
}
