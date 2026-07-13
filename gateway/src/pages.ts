import { PublicStats } from './stats';

/* Server-rendered HTML for the public /stats showcase and the /admin dashboard.
   Both pages are fully self-contained (inline CSS/JS, no external assets). The
   stats page embeds only the aggregate JSON that /v1/stats already exposes; the
   admin page contains no data at all — it asks for the admin token in-browser
   and talks to /admin/api/* with it, so the HTML itself is safe to serve. */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c] as string);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function renderStatsPage(stats: PublicStats): string {
  const days = Object.entries(stats.days).sort(([a], [b]) => (a < b ? -1 : 1));
  const maxSaved = Math.max(1, ...days.map(([, d]) => d.tokensSaved));
  const bars = days.map(([day, d]) => {
    const h = Math.max(2, Math.round((d.tokensSaved / maxSaved) * 120));
    return `<div class="bar" title="${escapeHtml(day)}: ${fmt(d.tokensSaved)} tokens saved (${d.calls} calls)" style="height:${h}px"></div>`;
  }).join('');
  const toolRows = Object.entries(stats.byTool)
    .sort(([, a], [, b]) => b.calls - a.calls)
    .map(([name, t]) => `<tr><td>${escapeHtml(name)}</td><td>${fmt(t.calls)}</td><td>${fmt(t.tokensSaved)}</td><td>${(t.averageSavingsPercentage * 100).toFixed(1)}%</td></tr>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>token-optimizer — global impact</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3;padding:2rem 1rem;display:flex;justify-content:center}
main{max-width:860px;width:100%}
h1{font-size:1.6rem;margin:0 0 .25rem}
p.sub{color:#8b949e;margin:0 0 2rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1rem}
.card .v{font-size:1.8rem;font-weight:700;color:#58a6ff}
.card .l{color:#8b949e;font-size:.85rem;margin-top:.25rem}
.chart{display:flex;align-items:flex-end;gap:3px;height:130px;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1rem;margin-bottom:2rem;overflow-x:auto}
.bar{flex:0 0 6px;background:#238636;border-radius:2px 2px 0 0;min-width:6px}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #21262d;font-size:.9rem}
th{color:#8b949e;font-weight:600}
footer{color:#484f58;font-size:.8rem;margin-top:2rem}
</style></head><body><main>
<h1>token-optimizer</h1>
<p class="sub">Global, anonymous usage impact across all installations. No user data — aggregate counters only.</p>
<div class="cards">
<div class="card"><div class="v">${fmt(stats.totalCalls)}</div><div class="l">tool calls optimized</div></div>
<div class="card"><div class="v">${fmt(stats.totalTokensSaved)}</div><div class="l">main-context tokens saved</div></div>
<div class="card"><div class="v">${(stats.averageSavingsPercentage * 100).toFixed(1)}%</div><div class="l">average context savings</div></div>
<div class="card"><div class="v">${fmt(stats.totalLocalLlmTokens)}</div><div class="l">tokens handled by small models</div></div>
</div>
<h2 style="font-size:1.1rem">Tokens saved — full history (${days.length} active day${days.length === 1 ? '' : 's'})</h2>
<div class="chart">${bars || '<span style="color:#8b949e">No data yet.</span>'}</div>
<h2 style="font-size:1.1rem">By tool</h2>
<table><thead><tr><th>Tool</th><th>Calls</th><th>Tokens saved</th><th>Avg savings</th></tr></thead>
<tbody>${toolRows || '<tr><td colspan="4" style="color:#8b949e">No data yet.</td></tr>'}</tbody></table>
<footer>Updated ${escapeHtml(stats.updatedAt)} · JSON at <code>/v1/stats</code></footer>
</main></body></html>`;
}

export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>token-optimizer — admin</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;margin:0;background:#0d1117;color:#e6edf3;padding:2rem 1rem;display:flex;justify-content:center}
main{max-width:960px;width:100%}
h1{font-size:1.4rem}
input,button{font:inherit;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#e6edf3;padding:.4rem .6rem}
button{cursor:pointer}button:hover{background:#21262d}
button.ok{border-color:#238636}button.bad{border-color:#da3633}
table{width:100%;border-collapse:collapse;margin-top:1rem;background:#161b22;border:1px solid #30363d}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid #21262d;font-size:.85rem}
.status-pending{color:#d29922}.status-approved{color:#3fb950}.status-denied{color:#f85149}.status-revoked{color:#8b949e}
#msg{margin-top:.75rem;font-size:.85rem;white-space:pre-wrap;word-break:break-all;color:#d29922}
.limit{width:4.5rem}
</style></head><body><main>
<h1>Access token requests</h1>
<div>
<input id="admintoken" type="password" placeholder="admin token" size="36">
<button onclick="load()">Load</button>
</div>
<div id="msg"></div>
<table><thead><tr><th>Email</th><th>Status</th><th>Requested</th><th>Used today / limit</th><th>Total</th><th>Actions</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function headers(){return{'Content-Type':'application/json',Authorization:'Bearer '+document.getElementById('admintoken').value.trim()}}
function say(t){document.getElementById('msg').textContent=t}
async function api(path,body){
  const res=await fetch(path,{method:body?'POST':'GET',headers:headers(),body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(function(){return{}});
  if(!res.ok){throw new Error(data.error||('HTTP '+res.status))}
  return data;
}
async function load(){
  say('');
  try{
    const data=await api('/admin/api/requests');
    const rows=data.requests.map(function(r){
      return '<tr><td>'+esc(r.email)+'</td>'
        +'<td class="status-'+esc(r.status)+'">'+esc(r.status)+'</td>'
        +'<td>'+esc((r.requestedAt||'').slice(0,10))+'</td>'
        +'<td>'+esc(r.usageCount||0)+' / <input class="limit" type="number" min="0" value="'+esc(r.dailyLimit)+'" onchange="setLimit(\\''+esc(r.email)+'\\',this.value)"></td>'
        +'<td>'+esc(r.totalCalls||0)+'</td>'
        +'<td><button class="ok" onclick="act(\\'approve\\',\\''+esc(r.email)+'\\')">Approve</button> '
        +'<button onclick="act(\\'deny\\',\\''+esc(r.email)+'\\')">Deny</button> '
        +'<button class="bad" onclick="act(\\'revoke\\',\\''+esc(r.email)+'\\')">Revoke</button></td></tr>';
    }).join('');
    document.getElementById('rows').innerHTML=rows||'<tr><td colspan="6">No requests.</td></tr>';
  }catch(e){say(e.message)}
}
async function act(action,email){
  try{
    const data=await api('/admin/api/'+action,{email:email});
    if(action==='approve'){
      say(data.emailSent
        ? 'Approved '+email+' — token emailed.'
        : 'Approved '+email+' — EMAIL NOT SENT ('+(data.emailError||'not configured')+').\\nDeliver this token manually (shown once):\\n'+data.token);
    }else{say(action+' ok for '+email)}
    load();
  }catch(e){say(e.message)}
}
async function setLimit(email,value){
  try{await api('/admin/api/limit',{email:email,dailyLimit:Number(value)});say('Limit updated for '+email)}catch(e){say(e.message)}
}
</script>
</main></body></html>`;
}

/* The public page is only a thin browser client for the established request
   endpoint, so API callers and form users share validation and token workflow. */
export function renderAccessRequestPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>token-optimizer — request access</title>
<style>
:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:38rem;margin:6vh auto;padding:0 1.25rem}form{display:grid;gap:.75rem}label{display:grid;gap:.35rem}input,button{font:inherit;padding:.65rem}button{justify-self:start}#message{min-height:1.5rem}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.about{border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.5rem}
.about h2{font-size:1rem;margin:0 0 .5rem}
.about p{margin:.4rem 0;font-size:.92rem;line-height:1.5}
.about a{color:inherit}
</style></head><body><main>
<h1>Request access</h1>
<section class="about">
<h2>What is token-optimizer?</h2>
<p>Token Optimizer is an MCP server that runs your project's build, lint, and test commands and turns large, noisy logs into compact, actionable results. Raw logs stay on your machine — your coding agent only sees a verdict, a triage summary, or a targeted excerpt, never the full log.</p>
<p>This gateway is a shared LLM backend the tool calls to classify those results. Requesting access here gets you a token so you can use the gateway provider instead of running your own local model or API key. See <a href="/stats">live impact stats</a> for aggregate usage across all installs.</p>
</section>
<p>Enter your email to request a token for the token-optimizer gateway.</p>
<form id="request-form"><label>Email <input id="email" name="email" type="email" autocomplete="email" required></label><div class="hp" aria-hidden="true"><label>Website <input id="website" name="website" type="text" tabindex="-1" autocomplete="off"></label></div><button type="submit">Request access</button></form>
<p id="message" role="status" aria-live="polite"></p>
<script>
/* The server remains authoritative; these inexpensive values only flag common
   automated form submissions without blocking compatible API callers. */
const form=document.getElementById('request-form');const email=document.getElementById('email');const website=document.getElementById('website');const message=document.getElementById('message');const startedAt=Date.now();
form.addEventListener('submit',async function(event){event.preventDefault();message.textContent='Submitting…';try{const response=await fetch('/v1/token-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value.trim(),website:website.value,startedAt})});if(response.status===202){message.textContent='Request submitted. You will receive your token after approval.';form.reset();return}if(response.status===400){message.textContent='Enter a valid email address.';return}if(response.status===409){message.textContent='A request already exists for this email address.';return}if(response.status===429){message.textContent='Too many requests. Please try again shortly.';return}message.textContent='Unable to submit your request. Please try again.'}catch(_error){message.textContent='Unable to submit your request. Please try again.'}});
</script></main></body></html>`;
}
