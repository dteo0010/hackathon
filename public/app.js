// Review screen. Plain JS, no build step. Talks to src/server.js.
// Routes: #/queue, #/queue/<email_id>, #/report

const $ = (sel, el = document) => el.querySelector(sel);
const main = $('#main');
const state = { meta: null, summary: null, scope: 'attention', selected: null, roles: null, docTab: null, docsOnly: true, resultFilter: '', queueIds: [] };

// Everything from emails/documents is untrusted text: always escape.
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isError ? 6000 : 3500);
}

const reviewer = () => $('#reviewer').value.trim() || null;
$('#reviewer').value = localStorage.getItem('reviewer') || '';
$('#reviewer').addEventListener('input', (e) => localStorage.setItem('reviewer', e.target.value));

/** Run an action on a button, disabling it while it runs; errors become a toast. */
async function act(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

// --------------------------------------------------------------------- sidebar
let pollTimer = null;
async function refreshSidebar() {
  const s = await api('GET', '/api/summary');
  state.summary = s;
  state.meta = s.meta;
  const c = s.counts;
  $('#counts').innerHTML = `
    <li><b>${c.IN_REVIEW}</b> need review</li>
    <li><b>${c.FAILED}</b> failed</li>
    <li><b>${c.DONE}</b> checked automatically</li>
    <li><b>${c.REVIEWED}</b> reviewed by a person</li>`;

  const job = s.job;
  let html = '';
  if (job.running) {
    html = `<p>Processing ${job.done} of ${job.total || '…'}</p><progress max="${job.total || 1}" value="${job.done}" style="width:100%"></progress>`;
  } else if (s.dataAvailable) {
    html = '<button class="btn block" id="process" title="Runs every email that isn\'t finished yet. Failed ones are tried again.">Process inbox</button>';
  } else if (s.isDemo) {
    html = '<p class="hint">No inbox found. Load the built-in demo emails to try the review flow.</p><button class="btn block" id="demo">Load demo inbox</button>';
  } else {
    html = `<p class="banner failed">Inbox not found at ${esc(s.dataSource)}. Set PIPELINE_DATA.</p>`;
  }
  if (job.error) html += `<p class="banner failed">Last run stopped: ${esc(job.error)}</p>`;
  $('#job').innerHTML = html;
  $('#process')?.addEventListener('click', (e) => act(e.target, () => startJob('/api/process')));
  $('#demo')?.addEventListener('click', (e) => act(e.target, () => startJob('/api/demo')));
  $('#source').innerHTML = `Inbox: ${esc(s.dataSource)}${s.isDemo ? '<br>Using demo classify/extract/compare.' : ''}`;

  if (job.running && !pollTimer) {
    pollTimer = setInterval(async () => {
      const again = await api('GET', '/api/summary');
      if (!again.job.running) {
        clearInterval(pollTimer);
        pollTimer = null;
        const k = again.counts;
        if (!again.job.error) toast(`Done: ${k.IN_REVIEW} need review, ${k.FAILED} failed.`);
        route();
      } else {
        refreshSidebar();
      }
    }, 1000);
  }
}

async function startJob(url) {
  await api('POST', url);
  await refreshSidebar();
}

// ---------------------------------------------------------------------- router
async function route() {
  const [, view = 'queue', id] = location.hash.replace(/^#\/?/, '#/').split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === view));
  try {
    await refreshSidebar();
    if (view === 'report') await renderReport();
    else await renderQueue(id ? decodeURIComponent(id) : null);
  } catch (err) {
    main.innerHTML = `<p class="banner failed">${esc(err.message)}</p>`;
  }
}
window.addEventListener('hashchange', route);

// ----------------------------------------------------------------------- queue
const SCOPES = [['attention', 'Needs attention'], ['mismatch', 'Mismatches'], ['reviewed', 'Reviewed'], ['all', 'All document checks']];

async function renderQueue(id) {
  const q = await api('GET', `/api/queue?scope=${state.scope}`);
  if (id && !q.items.some((i) => i.emailId === id) && state.scope !== 'all') {
    state.scope = 'all';
    return renderQueue(id);
  }
  state.queueIds = q.items.map((i) => i.emailId);
  const selected = id || q.items[0]?.emailId || null;
  if (selected !== state.selected) { state.roles = null; state.docTab = null; }
  state.selected = selected;

  let body;
  if (!q.items.length) {
    const msg = q.total === 0
      ? 'No emails processed yet. Use Process inbox (or Load demo inbox) in the sidebar.'
      : state.scope === 'attention'
        ? 'Nothing is waiting for review. Every processed email was checked automatically or has been reviewed. See the Report for results.'
        : state.scope === 'mismatch' ? 'No mismatches found.' : 'No emails here yet.';
    body = `<p class="banner ${q.total && state.scope === 'attention' ? 'ok' : 'info'}">${msg}</p>`;
  } else {
    body = `<div class="split">
      <ul class="queue">${q.items.map((i) => `
        <li><a href="#/queue/${encodeURIComponent(i.emailId)}" class="${i.emailId === state.selected ? 'selected' : ''}">
          <span class="id">${esc(i.emailId)}</span>
          <span class="why ${i.state === 'FAILED' ? 'failed' : ''}">${esc(i.label)}</span></a></li>`).join('')}
      </ul>
      <section id="detail"></section></div>`;
  }
  main.innerHTML = `<h2>Review queue</h2>
    <div class="scope" role="group" aria-label="Show">${SCOPES.map(([k, label]) =>
      `<button data-scope="${k}" aria-pressed="${state.scope === k}">${label}</button>`).join('')}</div>${body}`;
  main.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    state.selected = null;
    location.hash = '#/queue';
    route();
  }));
  if (state.selected) await renderDetail(state.selected);
}

async function renderDetail(id) {
  const rolesParam = state.roles ? `?roles=${encodeURIComponent(JSON.stringify(state.roles))}` : '';
  const d = await api('GET', `/api/emails/${encodeURIComponent(id)}${rolesParam}`);
  const rec = d.record;
  const docs = rec.result?.documents || [];
  const showFields = d.category === 'BL_COMPARISON' && docs.length > 0;

  $('#detail').innerHTML = `
    <h3>${esc(rec.subject || rec.emailId)}</h3>
    <p class="meta">${esc(rec.emailId)}, from ${esc(d.email?.from || 'unknown sender')}</p>
    ${banner(d)}
    <details><summary>Email</summary><div class="body">
      <pre class="text">${esc(d.email?.body || '(no body)')}</pre>
      <p class="meta">Attachments: ${esc((d.email?.attachments || []).join(', ') || 'none')}</p></div></details>
    ${showFields ? fieldsSection(d) + documentsSection(docs, rec) : ''}
    ${decisionSection(d)}
    ${historySection(d)}`;
  wireDetail(d);
}

function banner(d) {
  const rec = d.record;
  if (rec.state === 'FAILED') {
    return `<div class="banner failed"><strong>Processing failed at ${esc(rec.errorStage)}</strong>
      after ${rec.attempts} attempt${rec.attempts === 1 ? '' : 's'}.<p>${esc(rec.errorMessage)}</p></div>
      <div class="row"><button class="btn primary" id="retry">Retry processing</button>
      <span class="hint">Runs the whole email again. Check the error first if it keeps failing.</span></div>
      <details><summary>Technical details</summary><div class="body"><pre class="text">${esc(rec.errorTrace)}</pre></div></details>`;
  }
  if (rec.state === 'IN_REVIEW' && rec.assessment) {
    const more = rec.assessment.issues.slice(1).map((i) => `<p>Also: ${esc(i.detail)}</p>`).join('');
    return `<div class="banner review"><strong>${esc(d.reasonLabel || 'Needs review')}.</strong> ${esc(rec.assessment.detail)}${more}</div>`;
  }
  if (rec.state === 'REVIEWED') {
    const last = d.reviews[d.reviews.length - 1] || {};
    return `<div class="banner info">Reviewed${last.reviewer ? ` by ${esc(last.reviewer)}` : ''}: ${esc(d.summary)}
      ${last.note ? `<p>Note: ${esc(last.note)}</p>` : ''}</div>`;
  }
  const kind = rec.outcome.status === 'MISMATCH' ? 'failed' : rec.outcome.status === 'AWAITING_DOCS' ? 'info' : 'ok';
  return `<div class="banner ${kind}">${esc(d.summary)}</div>`;
}

function fieldsSection(d) {
  const roles = d.needsRoles ? `
    <p class="hint">Tell us which file is which. Pick Ignore for anything that isn't the SI or BL.</p>
    <div class="roles">${Object.entries(d.roles).map(([p, role]) => `
      <label class="field">${esc(p.split('/').pop())}
        <select data-role="${esc(p)}">${state.meta.roles.map((r) =>
          `<option ${r === role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`).join('')}</div>` : '';
  const rows = d.rows.map((r) => {
    const cls = r.match === false ? 'mismatch' : '';
    const verdict = r.match === null ? '' : r.match ? 'Match' : 'Mismatch';
    return `<tr class="${cls}"><td>${esc(r.label)}</td>
      <td><input data-side="si" data-field="${r.field}" value="${esc(r.si)}" aria-label="SI ${esc(r.label)}" class="${r.si ? '' : 'blank'}"></td>
      <td><input data-side="bl" data-field="${r.field}" value="${esc(r.bl)}" aria-label="BL ${esc(r.label)}" class="${r.bl ? '' : 'blank'}"></td>
      <td class="verdict">${verdict}</td></tr>`;
  }).join('');
  return `<h4>Shipment fields</h4>${roles}
    <table class="compare"><thead><tr><th>Field</th><th class="doc">SI (reference)</th><th class="doc">Draft BL</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="row" style="margin-top:.75rem">
      <input id="cnote" placeholder="Note (optional)" style="flex:1;min-width:200px">
      <button class="btn primary" id="save">Save corrections and recompare</button></div>`;
}

/** Open the tab of the document the problem is in: a missing file, else the first doc named in the issue. */
function problemDocIndex(rec, docs) {
  const missing = docs.findIndex((d) => !d.found);
  if (missing >= 0) return missing;
  const evidenceDocs = (rec.assessment?.issues || []).flatMap((i) => i.evidence.map((e) => e.doc));
  const onlyOne = [...new Set(evidenceDocs)].length === 1;
  const hit = onlyOne ? docs.findIndex((d) => d.path === evidenceDocs[0]) : -1;
  return hit >= 0 ? hit : 0;
}

function documentsSection(docs, rec) {
  if (state.docTab === null) state.docTab = problemDocIndex(rec, docs);
  const i = Math.min(state.docTab, docs.length - 1);
  const doc = docs[i];
  const tabs = docs.map((dd, k) => `<button role="tab" data-tab="${k}" aria-selected="${k === i}">${esc(dd.path.split('/').pop())}</button>`).join('');
  let pane;
  if (!doc.found) {
    pane = '<p class="banner review">This file is listed in the email but isn\'t there.</p>';
  } else {
    const meta = [`Detected as ${doc.docType}`, doc.method && `read with ${doc.method}`,
      doc.ocrConfidence !== null && `OCR confidence ${Math.round(doc.ocrConfidence * 100)}%`].filter(Boolean).join(', ');
    const url = `/api/attachment?path=${encodeURIComponent(doc.path)}`;
    const ext = doc.path.toLowerCase().split('.').pop();
    let original = '';
    if (ext === 'pdf') original = `<iframe class="original" src="${url}" title="Original PDF"></iframe>`;
    else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) original = `<img class="original" src="${url}" alt="Original scan">`;
    const download = ext === 'txt' ? '' : `<a class="btn" href="${url}&download=1">Download original</a>`;
    pane = `<p class="meta">${esc(meta)}</p>
      ${doc.error ? `<p class="banner failed">Could not be read: ${esc(doc.error)}</p>` : ''}
      ${original}${download}
      <details ${original ? '' : 'open'}><summary>Extracted text</summary><div class="body">
        <pre class="text">${esc(doc.text || '(no text extracted)')}</pre></div></details>`;
  }
  return `<h4>Source documents</h4><div class="tabs" role="tablist">${tabs}</div>${pane}`;
}

function decisionSection(d) {
  const rec = d.record;
  const m = state.meta;
  const cat = d.category || 'BL_COMPARISON';
  const confirmBtn = rec.state === 'FAILED' ? '' : rec.state === 'IN_REVIEW'
    ? '<button class="btn" id="confirm" title="Keeps the result as needs review and closes it here.">Confirm it can\'t be checked</button>'
    : '<button class="btn" id="confirm">Confirm result</button>';
  return `<h4>Decision</h4><div class="row">${confirmBtn}</div>
    <details id="override"><summary>Override the result</summary><div class="body">
      <label class="field">Category <select id="ocat">${m.categories.map((c) => `<option ${c === cat ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="field bl-only">Result <select id="ostatus">${m.statuses.map((s) => `<option ${s === rec.outcome.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      <fieldset class="field bl-only mm-only" style="border:0;padding:0;margin:0">Mismatched fields
        <div class="checks">${m.fields.map((f) => `<label><input type="checkbox" value="${f.id}" ${(rec.outcome.defectFields || []).includes(f.id) ? 'checked' : ''}>${esc(f.label)}</label>`).join('')}</div></fieldset>
      <label class="field bl-only nr-only">Reason <select id="oreason">${m.reasons.map((r) => `<option value="${r.id}" ${r.id === rec.outcome.reviewReason ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
      <label class="field">Why? <span class="hint">required, goes in the audit trail</span>
        <textarea id="onote" rows="2" placeholder="e.g. Asked the shipper for the draft BL on 20 Sep"></textarea></label>
      <div><button class="btn primary" id="osave">Save override</button></div></div></details>`;
}

function historySection(d) {
  const reviews = d.reviews.map((r) => `<li><span class="when">${esc(r.createdAt)}</span>
    <strong>${esc(r.action)}</strong> by ${esc(r.reviewer || 'unnamed reviewer')}:
    ${esc(r.before.status || r.before.category || 'none')} to ${esc(r.after.status || r.after.category)}
    ${r.note ? `<br>${esc(r.note)}` : ''}</li>`).join('');
  const events = d.events.map((e) => `<li><span class="when">${esc(e.createdAt)}</span>${esc(e.kind)}${e.detail ? `: ${esc(e.detail)}` : ''}</li>`).join('');
  return `<details><summary>History</summary><div class="body">
    ${reviews ? `<ul class="history">${reviews}</ul>` : '<p class="meta">No reviews yet.</p>'}
    <ul class="history">${events}</ul></div></details>`;
}

function wireDetail(d) {
  const id = d.record.emailId;
  // After a decision, stay on "Needs attention" and move to the next email.
  const done = async (res, verb) => {
    toast(`${verb}. ${res.summary}`);
    if (state.scope === 'attention') {
      const still = (await api('GET', '/api/queue?scope=attention')).items.map((i) => i.emailId);
      if (!still.includes(id)) {
        const after = state.queueIds.slice(state.queueIds.indexOf(id) + 1).find((x) => still.includes(x));
        const target = `#/queue/${encodeURIComponent(after || still[0] || '')}`.replace(/\/$/, '');
        if (location.hash !== target) { location.hash = target; return; }
      }
    }
    await route();
  };

  $('#retry')?.addEventListener('click', (e) => act(e.target, async () => {
    const res = await api('POST', `/api/emails/${encodeURIComponent(id)}/retry`);
    if (res.record.state === 'FAILED') {
      toast(`Still failing: ${res.record.errorMessage}`, true);
      await route();
    } else {
      await done(res, 'Processed');
    }
  }));

  document.querySelectorAll('[data-role]').forEach((sel) => sel.addEventListener('change', () => {
    state.roles = Object.fromEntries([...document.querySelectorAll('[data-role]')].map((s) => [s.dataset.role, s.value]));
    renderDetail(id);
  }));

  $('#save')?.addEventListener('click', (e) => act(e.target, async () => {
    const values = { si: {}, bl: {} };
    document.querySelectorAll('.compare input').forEach((inp) => { values[inp.dataset.side][inp.dataset.field] = inp.value; });
    const res = await api('POST', `/api/emails/${encodeURIComponent(id)}/corrections`, {
      siValues: values.si, blValues: values.bl, roles: d.needsRoles ? d.roles : null,
      reviewer: reviewer(), note: $('#cnote').value || null,
    });
    state.roles = null;
    await done(res, 'Saved');
  }));

  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.docTab = Number(b.dataset.tab);
    renderDetail(id);
  }));

  $('#confirm')?.addEventListener('click', (e) => act(e.target, async () => {
    await done(await api('POST', `/api/emails/${encodeURIComponent(id)}/confirm`, { reviewer: reviewer() }), 'Confirmed');
  }));

  // override form: show only the inputs that apply
  const sync = () => {
    const isBl = $('#ocat').value === 'BL_COMPARISON';
    const status = $('#ostatus').value;
    document.querySelectorAll('.bl-only').forEach((el) => { el.hidden = !isBl; });
    document.querySelectorAll('.mm-only').forEach((el) => { el.hidden = !isBl || status !== 'MISMATCH'; });
    document.querySelectorAll('.nr-only').forEach((el) => { el.hidden = !isBl || status !== 'NEEDS_REVIEW'; });
  };
  $('#ocat').addEventListener('change', sync);
  $('#ostatus').addEventListener('change', sync);
  sync();
  $('#osave').addEventListener('click', (e) => act(e.target, async () => {
    const isBl = $('#ocat').value === 'BL_COMPARISON';
    const res = await api('POST', `/api/emails/${encodeURIComponent(id)}/override`, {
      category: $('#ocat').value,
      status: isBl ? $('#ostatus').value : null,
      defectFields: [...document.querySelectorAll('#override .checks input:checked')].map((c) => c.value),
      reviewReason: $('#oreason').value,
      reviewer: reviewer(),
      note: $('#onote').value,
    });
    await done(res, 'Override saved');
  }));
}

// ---------------------------------------------------------------------- report
const label = (field) => state.meta.fields.find((f) => f.id === field)?.label || field;

async function renderReport() {
  const r = await api('GET', '/api/report');
  if (!r.rows.length) {
    main.innerHTML = '<h2>Report</h2><p class="banner info">No emails processed yet. Use Process inbox in the sidebar.</p>';
    return;
  }
  let rows = state.docsOnly ? r.rows.filter((x) => x.category === 'BL_COMPARISON' || x.state === 'FAILED') : r.rows;
  if (state.resultFilter) rows = rows.filter((x) => x.result === state.resultFilter);
  const details = (x) => x.mismatches.length
    ? `<ul class="mm">${x.mismatches.map((m) => `<li>${esc(label(m.field))}: SI <b>${esc(m.si ?? '?')}</b> / BL <b>${esc(m.bl ?? '?')}</b></li>`).join('')}</ul>`
    : esc(x.details);
  main.innerHTML = `<h2>Report</h2>
    <div class="row" style="margin:.5rem 0 1rem">
      <label class="row"><input type="checkbox" id="docsOnly" style="width:auto" ${state.docsOnly ? 'checked' : ''}> Document checks only</label>
      <label class="row">Result
        <select id="resultFilter" style="width:auto">${[['', 'All'], ['OK', 'OK'], ['MISMATCH', 'Mismatch'], ['NEEDS_REVIEW', 'Needs review'], ['AWAITING_DOCS', 'Waiting for documents'], ['FAILED', 'Failed']]
          .map(([v, l]) => `<option value="${v}" ${state.resultFilter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <span class="meta">${rows.length} shown</span>
      <a class="btn" href="/api/submission">Download submission.json</a>
      ${state.summary.canScore ? '<button class="btn primary" id="score">Score with organisers\' server</button>' : ''}
    </div>
    ${r.warnings.map((w) => `<p class="banner review">${esc(w)}</p>`).join('')}
    <div class="table-wrap"><table class="report"><thead><tr>
      <th>Email</th><th>Subject</th><th>Category</th><th>Result</th><th>Details</th><th>Reviewed by a person</th></tr></thead>
    <tbody>${rows.map((x) => `<tr>
      <td><a href="#/queue/${encodeURIComponent(x.emailId)}">${esc(x.emailId)}</a></td>
      <td>${esc(x.subject)}</td><td>${esc(x.category || '')}</td>
      <td>${x.result ? `<span class="pill ${esc(x.result)}">${esc(x.result)}</span>` : ''}</td>
      <td>${details(x)}</td><td>${x.reviewed ? 'Yes' : ''}</td></tr>`).join('')}</tbody></table></div>
    <div id="scoreOut"></div>`;
  $('#docsOnly').addEventListener('change', (e) => { state.docsOnly = e.target.checked; renderReport(); });
  $('#resultFilter').addEventListener('change', (e) => { state.resultFilter = e.target.value; renderReport(); });
  $('#score')?.addEventListener('click', (e) => act(e.target, async () => {
    const res = await api('POST', '/api/score', { note: prompt('Note for this score (what changed?)') || null });
    toast(`Scored: ${res.summary.final.toFixed(3)}`);
    await renderScores();
  }));
  await renderScores();
}

const num = (x) => (typeof x === 'number' ? x.toFixed(3) : esc(x ?? '-'));

/** Format check against sample_submission.json + history of the organisers' scores. */
async function renderScores() {
  const [fmt, scores] = await Promise.all([api('GET', '/api/format'), api('GET', '/api/scores')]);
  let html = '';
  if (fmt.checked) {
    html += fmt.problems.length
      ? `<div class="banner failed"><strong>Submission format problems</strong>${fmt.problems.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
      : '<p class="banner ok">submission.json matches the format of sample_submission.json.</p>';
  }
  if (scores.length) {
    const rows = scores.map((s, i) => {
      const prev = scores[i + 1]?.summary.final;
      const delta = typeof prev === 'number' ? s.summary.final - prev : null;
      return `<tr><td>${esc(s.savedAt.replace('T', ' ').slice(0, 16))}</td>
        <td><b>${num(s.summary.final)}</b>${delta === null ? '' : ` <span class="meta">(${delta >= 0 ? '+' : ''}${delta.toFixed(3)})</span>`}</td>
        <td>${num(s.summary.endToEndRate)} <span class="meta">${esc(s.summary.endToEnd)}</span></td>
        <td>${num(s.summary.classificationMacroF1)}</td><td>${num(s.summary.defectF1)}</td>
        <td>${num(s.summary.escalationPrecision)} / ${num(s.summary.escalationRecall)}</td>
        <td>${Object.entries(s.summary.perReason).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} ${esc(v)}`).join('<br>')}</td>
        <td>${esc(s.meta?.note || '')}</td></tr>`;
    }).join('');
    html += `<h4>Score history</h4><div class="table-wrap"><table class="report"><thead><tr>
      <th>When</th><th>Final</th><th>End-to-end</th><th>Classification</th><th>Defect F1</th>
      <th>Escalation precision / recall</th><th>Review cases caught</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  $('#scoreOut').innerHTML = html;
}

route();
