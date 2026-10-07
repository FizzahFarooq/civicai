/* CivicAI front-end. Plain JavaScript, no build step. */
(() => {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const main = $('#main');
  const state = { config: null, token: sessionStorage.getItem('civicai_token') || null, maps: [], dashTab: 'overview', filters: { group: 'open', level: '', category: '' } };

  const LEVEL_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
  const STATUS_LABEL = { submitted: 'Submitted', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Repaired, awaiting check', verified: 'Verified fixed', reopened: 'Reopened' };
  const VERIFY_LABEL = { none: 'Not repaired yet', pending: 'Waiting for photo check', verified: 'Fix verified', incomplete: 'Possible incomplete fix', needs_review: 'Needs staff review' };

  const badge = (lvl) => `<span class="badge ${esc(lvl)}">${LEVEL_LABEL[lvl] || esc(lvl)}</span>`;
  const statusPill = (s) => `<span class="pill s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
  const fmtDate = (iso) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  function ago(iso) {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.round(m / 60)} h ago`;
    const d = Math.round(m / 1440);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200);
  }

  async function api(path, { method = 'GET', json, form, auth } = {}) {
    const headers = {};
    let body;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (form) body = form;
    if (auth && state.token) headers.Authorization = 'Bearer ' + state.token;
    let res;
    try { res = await fetch(path, { method, headers, body }); }
    catch { throw new Error('Cannot reach the CivicAI server. Check that it is still running.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && auth) { state.token = null; sessionStorage.removeItem('civicai_token'); }
      const e = new Error(data.error || 'Something went wrong.'); e.status = res.status; throw e;
    }
    return data;
  }

  function clearMaps() { state.maps.forEach((m) => m.remove()); state.maps = []; }
  function makeMap(el, center, zoom = 14) {
    const map = L.map(el, { scrollWheelZoom: false }).setView([center.lat, center.lng], zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    state.maps.push(map);
    return map;
  }
  const pinIcon = (lvl, score, done) => L.divIcon({
    className: '', iconSize: [34, 34], iconAnchor: [17, 17],
    html: `<div class="pin ${lvl}${done ? ' done' : ''}"><b>${score}</b></div>`
  });

  function gauge(score, level) {
    return `<div class="gauge">
      <div class="gauge-top"><span class="gauge-num">${score}<small>/100</small></span>${badge(level)}</div>
      <div class="gauge-bar" role="img" aria-label="Severity ${score} out of 100, ${LEVEL_LABEL[level]}"><i style="left:${Math.min(99, score)}%"></i></div>
      <div class="gauge-scale" aria-hidden="true"><span>Low</span><span>Medium</span><span>High</span><span>Critical</span></div>
    </div>`;
  }

  // ---------- theme ----------
  function syncThemeBtn() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('#themeBtn .theme-txt').textContent = dark ? 'Light' : 'Dark';
    $('#themeBtn').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('civicai_theme', next);
    syncThemeBtn();
  });
  syncThemeBtn();

  // ---------- router ----------
  const routes = {
    '': viewHome, report: viewReport, track: viewTrack, dashboard: viewDashboard
  };
  async function route() {
    clearMaps();
    closeDrawer();
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    const name = parts[0] || '';
    $$('.nav a').forEach((a) => (a.dataset.nav === name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    if (!state.config) {
      try { state.config = await api('/api/config'); }
      catch (e) { main.innerHTML = `<div class="wrap page"><div class="notice bad">${esc(e.message)}</div></div>`; return; }
    }
    window.scrollTo(0, 0);
    await (routes[name] || viewHome)(parts[1]);
    main.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', route);

  // ======================================================
  // HOME
  // ======================================================
  async function viewHome() {
    document.title = 'CivicAI - From citizen reports to smarter cities';
    let s = { reports: 0, merged: 0, resolved: 0, verified: 0 };
    try { s = await api('/api/public/stats'); } catch { /* ignore */ }
    const cats = state.config.categories.filter((c) => c.id !== 'other');
    main.innerHTML = `
    <section class="hero"><div class="wrap hero-in">
      <div>
        <h1>Photograph the problem. CivicAI handles the rest.</h1>
        <p class="lead">Send one photo of a pothole, a broken streetlight or a leaking pipe. CivicAI works out what it is, how urgent it is and which department must fix it, then follows the repair until it is truly done.</p>
        <div class="btn-row">
          <a class="btn accent big" href="#/report">Report a problem</a>
          <a class="btn big" href="#/track">Track a report</a>
        </div>
      </div>
      <div>
        <div class="sign" role="img" aria-label="Example result: Pothole, severity 91 out of 100, sent to Road Maintenance Department, 37 citizens reported">
          <div class="sign-in">
            <div class="sign-top">
              <svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3 61 32 32 61 3 32Z" fill="#FFC20E" stroke="#06130D" stroke-width="3"/><rect x="29.5" y="16" width="5" height="21" fill="#06130D"/><rect x="29.5" y="42" width="5" height="5" fill="#06130D"/></svg>
              <div class="sign-title">Pothole</div>
              <div class="sign-score">91<small>of 100</small></div>
            </div>
            <p class="sign-reason">Large pothole + main road + school nearby + 37 citizen reports</p>
            <hr class="sign-rule">
            <p class="sign-line"><span>Sent to</span><span>Road Maintenance Department</span></p>
            <p class="sign-line"><span>First reported</span><span>4 days ago</span></p>
            <p class="sign-line"><span>Next step</span><span>Repair, then photo check</span></p>
          </div>
        </div>
        <p class="small sign-cap">Example of what CivicAI produces from a single photo.</p>
      </div>
    </div></section>

    <div class="wrap"><div class="stats" aria-label="Live numbers from this CivicAI system">
      <div class="stat"><b>${s.reports}</b><span>Citizen reports</span></div>
      <div class="stat"><b>${s.merged}</b><span>Duplicates merged</span></div>
      <div class="stat"><b>${s.resolved}</b><span>Issues repaired</span></div>
      <div class="stat"><b>${s.verified}</b><span>Repairs verified</span></div>
    </div></div>

    <section class="section"><div class="wrap">
      <h2>What happens after you press send</h2>
      <ol class="steps">
        <li><span class="n" aria-hidden="true">1</span><h3>You send a photo</h3><p>Your phone shares the photo and the place. You never pick a category or work out which office to contact.</p></li>
        <li><span class="n" aria-hidden="true">2</span><h3>AI reads the photo</h3><p>It names the problem and judges how dangerous it is to people and vehicles.</p></li>
        <li><span class="n" aria-hidden="true">3</span><h3>Priority is calculated</h3><p>Photo, road type, schools and hospitals nearby, and the number of reports combine into a score out of 100, with the reason shown.</p></li>
        <li><span class="n" aria-hidden="true">4</span><h3>Duplicates merge, the right office gets it</h3><p>Thirty people reporting one pothole become one issue with thirty voices. It goes straight to the responsible department.</p></li>
        <li><span class="n" aria-hidden="true">5</span><h3>The repair is checked</h3><p>After the department says it is fixed, you send a new photo. CivicAI compares before and after and flags repairs that look unfinished.</p></li>
      </ol>
    </div></section>

    <hr class="road-divider">

    <section class="section"><div class="wrap">
      <h2>Problems CivicAI recognises</h2>
      <ul class="cats">${cats.map((c) => `<li><span class="ico" aria-hidden="true">${c.icon}</span>${esc(c.label)}</li>`).join('')}</ul>
    </div></section>

    <section class="section band"><div class="wrap band-in">
      <div>
        <h2>For city authorities</h2>
        <p class="lead">One dashboard shows critical issues first, tells you which five to fix today, and points to roads likely to fail next.</p>
      </div>
      <div class="btn-row"><a class="btn accent big" href="#/dashboard">Open the dashboard</a></div>
    </div></section>`;
  }

  // ======================================================
  // REPORT
  // ======================================================
  const MY_KEY = 'civicai_my_reports';
  const myReports = () => { try { return JSON.parse(localStorage.getItem(MY_KEY)) || []; } catch { return []; } };
  function rememberReport(r) {
    const list = myReports().filter((x) => x.id !== r.id);
    list.unshift(r);
    localStorage.setItem(MY_KEY, JSON.stringify(list.slice(0, 20)));
  }

  // shrink big phone photos before upload
  async function shrink(file, max = 1600) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
      return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }

  function viewReport() {
    document.title = 'Report a problem - CivicAI';
    const manual = state.config.ai_mode !== 'vision';
    main.innerHTML = `
    <div class="wrap page">
      <div class="page-head">
        <h1>Report a problem</h1>
        <p class="lead">Add one photo and mark where it is. CivicAI identifies the problem, sets its priority and sends it to the right department.</p>
      </div>
      <form id="rf" class="report-grid" novalidate>
        <div class="panel">
          <h2>1. Photo</h2>
          <div id="dropArea">
            <label class="drop" id="drop" for="photo">
              <strong>Take or choose a photo</strong>
              <span>JPG, PNG or WebP</span>
              <input id="photo" name="photo" type="file" accept="image/jpeg,image/png,image/webp">
            </label>
          </div>
          <div id="previewBox" class="preview" hidden>
            <img id="previewImg" alt="Preview of the photo you selected">
            <button type="button" class="btn small-btn" id="clearPhoto">Change photo</button>
          </div>
          <div class="field" style="margin-top:1.1rem">
            <label for="desc">What should we know? (optional)</label>
            <textarea id="desc" name="description" maxlength="500" placeholder="For example: deep hole in the left lane, cars swerving"></textarea>
          </div>
          ${manual ? `
          <fieldset class="field" style="border:0;padding:0;margin:0">
            <legend class="label">What is the problem?</legend>
            <div class="chips">${state.config.categories.map((c, i) => `
              <label class="chip"><input type="radio" name="category" value="${esc(c.id)}"${i === 0 ? ' checked' : ''}><span><span aria-hidden="true">${c.icon}</span> ${esc(c.label)}</span></label>`).join('')}
            </div>
            <p class="hint">AI photo recognition is switched off on this server, so please choose the type. Add an API key in the .env file to let CivicAI detect it from the photo.</p>
          </fieldset>` : ''}
        </div>

        <div class="panel">
          <h2>2. Location</h2>
          <div class="btn-row" style="margin-bottom:.8rem">
            <button type="button" class="btn" id="gps">Use my current location</button>
          </div>
          <div id="rmap" class="map" role="application" aria-label="Map. Tap to place the problem marker."></div>
          <p class="coords" id="coords">Tap the map to place the pin on the problem.</p>
          <div class="field-row" style="margin-top:1rem">
            <div class="field"><label for="nm">Your name (optional)</label><input id="nm" name="name" type="text" maxlength="80" autocomplete="name"></div>
            <div class="field"><label for="ct">Phone or email (optional)</label><input id="ct" name="contact" type="text" maxlength="80" autocomplete="email"></div>
          </div>
          <p class="hint">Contact details let us ask you to confirm the repair. They are shown only to authorised staff.</p>
        </div>

        <div class="submit-row">
          <button class="btn primary big" id="send" type="submit">Send report</button>
          <p id="msg" role="alert" style="margin:0;font-weight:700"></p>
        </div>
      </form>
      <div id="result" hidden></div>
    </div>`;

    let file = null, pos = null, marker = null;
    const map = makeMap($('#rmap'), state.config.center, 14);
    const setPos = (lat, lng, zoom) => {
      pos = { lat, lng };
      if (!marker) {
        marker = L.marker([lat, lng], { draggable: true }).addTo(map);
        marker.on('dragend', () => { const p = marker.getLatLng(); setPos(p.lat, p.lng); });
      } else marker.setLatLng([lat, lng]);
      if (zoom) map.setView([lat, lng], zoom);
      $('#coords').textContent = `Pin placed at ${lat.toFixed(5)}, ${lng.toFixed(5)}. Drag it to adjust.`;
    };
    map.on('click', (e) => setPos(e.latlng.lat, e.latlng.lng));
    $('#gps').addEventListener('click', () => {
      if (!navigator.geolocation) return toast('Your browser cannot share location. Tap the map instead.');
      $('#coords').textContent = 'Finding your location...';
      navigator.geolocation.getCurrentPosition(
        (p) => setPos(p.coords.latitude, p.coords.longitude, 18),
        () => { $('#coords').textContent = 'Location is blocked. Allow location access, or tap the map to place the pin.'; },
        { enableHighAccuracy: true, timeout: 12000 }
      );
    });

    const showPreview = (f) => {
      file = f;
      $('#previewImg').src = URL.createObjectURL(f);
      $('#previewBox').hidden = false; $('#dropArea').hidden = true;
    };
    $('#photo').addEventListener('change', (e) => { if (e.target.files[0]) showPreview(e.target.files[0]); });
    $('#clearPhoto').addEventListener('click', () => { file = null; $('#photo').value = ''; $('#previewBox').hidden = true; $('#dropArea').hidden = false; });
    const drop = $('#drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) showPreview(f); });

    $('#rf').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#msg'); msg.textContent = '';
      if (!file) { msg.textContent = 'Add a photo of the problem first.'; return; }
      if (!pos) { msg.textContent = 'Tap the map to mark where the problem is.'; return; }
      const btn = $('#send');
      btn.disabled = true; btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> CivicAI is analysing your photo';
      try {
        const fd = new FormData();
        fd.append('photo', await shrink(file));
        fd.append('lat', pos.lat); fd.append('lng', pos.lng);
        for (const k of ['description', 'name', 'contact']) fd.append(k, $('#rf').elements[k].value);
        const cat = $('#rf').elements.category;
        if (cat && cat.value) fd.append('category', cat.value);
        const r = await api('/api/reports', { method: 'POST', form: fd });
        rememberReport({ id: r.tracking_id, label: r.issue.category_label, icon: r.issue.icon, at: new Date().toISOString() });
        showResult(r);
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false; btn.textContent = 'Send report';
      }
    });
  }

  function showResult(r) {
    const i = r.issue;
    $('#rf').hidden = true;
    const box = $('#result'); box.hidden = false;
    const banner = r.reopened
      ? `<div class="notice bad">This issue was marked as repaired, but a new report arrived. It has been reopened for the department.</div>`
      : r.merged
        ? `<div class="notice warn">This problem was already reported. Your photo was added to it, so it now has ${i.report_count} citizen reports and a higher priority.</div>`
        : `<div class="notice ok">Thank you. Your report is logged and has been sent to the department.</div>`;
    const ctx = [];
    if (i.context.road_type === 'main_road') ctx.push('Main road');
    if (i.context.schools && i.context.schools.length) ctx.push(`School ${i.context.schools[0].distance_m} m away`);
    if (i.context.hospitals && i.context.hospitals.length) ctx.push(`Hospital ${i.context.hospitals[0].distance_m} m away`);
    box.innerHTML = `
      ${banner}
      <div class="result">
        <div class="panel">
          <h2>${i.icon} ${esc(i.category_label)}</h2>
          ${gauge(i.severity, i.severity_level)}
          <dl class="facts">
            <dt>Why this score</dt><dd>${esc(i.severity_reason)}</dd>
            <dt>Sent to</dt><dd>${esc(i.department)}</dd>
            <dt>Citizen reports</dt><dd>${i.report_count}</dd>
            ${ctx.length ? `<dt>Surroundings</dt><dd>${esc(ctx.join(', '))}</dd>` : ''}
            ${r.merge_note ? `<dt>Matched because</dt><dd>${esc(r.merge_note)}</dd>` : ''}
            <dt>AI check</dt><dd>${r.ai.mode === 'vision' ? `Photo analysed (${Math.round(r.ai.confidence * 100)}% confident)` : 'Type chosen by you (photo AI is off)'}</dd>
          </dl>
        </div>
        <div class="panel">
          <h2>Your tracking ID</h2>
          <div class="track-id"><code id="tid">${esc(r.tracking_id)}</code><button class="btn small-btn" id="copy" type="button">Copy ID</button></div>
          <p class="hint" style="margin:.8rem 0 1.2rem">Keep this ID. Use it to follow the repair and confirm the fix with a new photo.</p>
          <div class="btn-row">
            <a class="btn primary" href="#/track/${encodeURIComponent(r.tracking_id)}">Track this report</a>
            <button class="btn" id="again" type="button">Report another</button>
          </div>
        </div>
      </div>`;
    $('#copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.tracking_id); toast('Tracking ID copied'); } catch { toast('Select the ID and copy it manually'); }
    });
    $('#again').addEventListener('click', route);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ======================================================
  // TRACK
  // ======================================================
  const STEPS = [['submitted', 'Submitted'], ['assigned', 'Assigned'], ['in_progress', 'In progress'], ['resolved', 'Repaired'], ['verified', 'Verified']];

  async function viewTrack(id) {
    document.title = 'Track a report - CivicAI';
    const mine = myReports();
    main.innerHTML = `
    <div class="wrap page">
      <div class="page-head"><h1>Track a report</h1><p class="lead">Enter your tracking ID to see who is handling the problem and whether it was really fixed.</p></div>
      <form id="tf" class="panel" style="max-width:640px;margin-bottom:1.6rem" novalidate>
        <div class="field"><label for="tid">Tracking ID</label><input id="tid" type="text" placeholder="CV-ABC123" autocomplete="off" autocapitalize="characters" value="${esc(id || '')}"></div>
        <button class="btn primary" type="submit">Show status</button>
        <p id="terr" role="alert" style="font-weight:700;margin:.8rem 0 0"></p>
      </form>
      ${!id && mine.length ? `<div class="panel" style="max-width:640px"><h2 style="font-size:1.6rem">Your recent reports</h2><ul class="my-list">${mine.map((m) => `<li><a class="btn" href="#/track/${encodeURIComponent(m.id)}" style="justify-content:space-between;width:100%"><span>${m.icon || ''} ${esc(m.label)}</span><span>${esc(m.id)}</span></a></li>`).join('')}</ul></div>` : ''}
      <div id="tout"></div>
    </div>`;
    $('#tf').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#tid').value.trim().toUpperCase();
      if (!v) { $('#terr').textContent = 'Enter the tracking ID you received after sending your report.'; return; }
      location.hash = '#/track/' + encodeURIComponent(v);
    });
    if (!id) return;
    const out = $('#tout');
    out.innerHTML = '<p><span class="spinner" aria-hidden="true"></span> Loading</p>';
    try {
      const t = await api('/api/track/' + encodeURIComponent(id));
      renderTrack(t, out);
    } catch (e) { out.innerHTML = ''; $('#terr').textContent = e.message; }
  }

  function renderTrack(t, out) {
    const i = t.issue;
    const idx = STEPS.findIndex((s) => s[0] === i.status);
    const stepsHtml = STEPS.map(([k, label], n) => {
      const cls = i.status === 'reopened' ? (n === 0 ? 'done' : '') : n < idx ? 'done' : n === idx ? (k === 'verified' ? 'done' : 'now') : '';
      return `<li class="${cls}">${label}</li>`;
    }).join('');
    const canVerify = ['resolved', 'reopened'].includes(i.status) || i.verification_status === 'incomplete';
    const awaiting = i.status === 'resolved';
    let vBox = '';
    if (i.status === 'verified') {
      vBox = `<div class="notice ok">Fix verified. ${esc(i.verification_note || '')}</div>`;
    } else if (i.verification_status === 'incomplete') {
      vBox = `<div class="notice bad">Possible incomplete resolution. ${esc(i.verification_note || '')} The department has been notified.</div>`;
    } else if (i.verification_status === 'needs_review') {
      vBox = `<div class="notice warn">Your photo was received. A staff member will review it. ${esc(i.verification_note || '')}</div>`;
    }
    const verifyForm = awaiting ? `
      <div class="panel" style="margin-top:1.4rem">
        <h2 style="font-size:1.8rem">Was it really fixed?</h2>
        <p>The department says this is repaired. Take a new photo from the same spot and CivicAI will compare it with the original.</p>
        <form id="vf" novalidate>
          <div class="field"><label for="after">New photo of the location</label><input id="after" type="file" accept="image/jpeg,image/png,image/webp"></div>
          <button class="btn accent" type="submit">Check the repair</button>
          <p id="verr" role="alert" style="font-weight:700;margin:.8rem 0 0"></p>
        </form>
      </div>` : '';
    out.innerHTML = `
      <div class="panel">
        <div style="display:flex;gap:.8rem;align-items:center;flex-wrap:wrap;margin-bottom:.4rem">
          <h2>${i.icon} ${esc(i.category_label)}</h2> ${statusPill(i.status)} ${badge(i.severity_level)}
        </div>
        <p class="small" style="margin-bottom:0">Tracking ID ${esc(t.tracking_id)}, sent ${esc(fmtDate(t.submitted_at))}</p>
        <ol class="progress" aria-label="Repair progress">${stepsHtml}</ol>
        ${i.status === 'reopened' ? '<div class="notice bad">This issue was reopened because the repair was not confirmed or a new report arrived.</div>' : ''}
        ${vBox}
        <dl class="facts">
          <dt>Department</dt><dd>${esc(i.department)}</dd>
          <dt>Priority</dt><dd>${i.severity}/100: ${esc(i.severity_reason)}</dd>
          <dt>Citizens reporting</dt><dd>${i.report_count}</dd>
          <dt>First reported</dt><dd>${esc(ago(i.first_reported_at))}</dd>
        </dl>
      </div>
      <div class="panel" style="margin-top:1.4rem">
        <h2 style="font-size:1.8rem">Photos</h2>
        <div class="photos">
          <figure>${t.your_photo ? `<img src="${esc(t.your_photo)}" alt="Photo you sent" loading="lazy">` : '<div class="noimg">No photo on file</div>'}<figcaption>Before (your report)</figcaption></figure>
          <figure>${i.after_photo ? `<img src="${esc(i.after_photo)}" alt="Photo taken after the repair" loading="lazy">` : '<div class="noimg">No after photo yet</div>'}<figcaption>After repair</figcaption></figure>
        </div>
      </div>
      ${verifyForm}
      <div class="panel" style="margin-top:1.4rem">
        <h2 style="font-size:1.8rem">What has happened</h2>
        <ul class="timeline">${t.events.slice().reverse().map((e) => `<li><time datetime="${esc(e.created_at)}">${esc(fmtDate(e.created_at))}</time><p>${esc(e.note || e.type)}</p></li>`).join('')}</ul>
      </div>`;
    const vf = $('#vf');
    if (vf) vf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = $('#after').files[0];
      if (!f) { $('#verr').textContent = 'Choose a photo first.'; return; }
      const btn = vf.querySelector('button'); btn.disabled = true; btn.textContent = 'Comparing photos...';
      try {
        const fd = new FormData(); fd.append('photo', await shrink(f));
        await api(`/api/track/${encodeURIComponent(t.tracking_id)}/verify`, { method: 'POST', form: fd });
        const fresh = await api('/api/track/' + encodeURIComponent(t.tracking_id));
        renderTrack(fresh, out);
        toast('Photo checked');
      } catch (err) { $('#verr').textContent = err.message; btn.disabled = false; btn.textContent = 'Check the repair'; }
    });
  }

  // ======================================================
  // DASHBOARD
  // ======================================================
  function viewDashboard() {
    document.title = 'Authority dashboard - CivicAI';
    if (!state.token) return renderLogin();
    renderDash();
  }

  function renderLogin(err) {
    main.innerHTML = `
    <div class="wrap page"><div class="login panel">
      <h1 style="font-size:2.6rem;margin-bottom:.4rem">Authority sign in</h1>
      <p class="hint" style="margin-bottom:1.2rem">For municipal staff only.</p>
      <form id="lf" novalidate>
        <div class="field"><label for="u">Username</label><input id="u" type="text" autocomplete="username"></div>
        <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password"></div>
        <button class="btn primary big" type="submit">Sign in</button>
        <p id="lerr" role="alert" style="font-weight:700;margin:.9rem 0 0">${esc(err || '')}</p>
      </form>
    </div></div>`;
    $('#lf').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/admin/login', { method: 'POST', json: { username: $('#u').value, password: $('#p').value } });
        state.token = r.token; sessionStorage.setItem('civicai_token', r.token);
        renderDash();
      } catch (er) { $('#lerr').textContent = er.message; }
    });
  }

  const authFail = (e) => { if (e.status === 401) { renderLogin('Your session ended. Please sign in again.'); return true; } return false; };

  function renderDash() {
    clearMaps();
    main.innerHTML = `
    <div class="wrap page">
      <div class="dash-head">
        <div><h1 style="font-size:clamp(2.2rem,5vw,3.4rem)">Authority dashboard</h1><p class="small" style="margin:.4rem 0 0">AI mode: ${state.config.ai_mode === 'vision' ? 'photo analysis on' : 'manual categories (no API key)'}</p></div>
        <button class="btn small-btn" id="logout" type="button">Sign out</button>
      </div>
      <div class="tabs" role="tablist" aria-label="Dashboard sections">
        ${[['overview', 'Overview'], ['issues', 'All issues'], ['hotspots', 'Predicted hotspots']].map(([k, l]) =>
          `<button role="tab" id="tab-${k}" aria-selected="${state.dashTab === k}" data-tab="${k}">${l}</button>`).join('')}
      </div>
      <div id="tabBody" role="tabpanel"></div>
    </div>`;
    $('#logout').addEventListener('click', async () => {
      try { await api('/api/admin/logout', { method: 'POST', auth: true }); } catch { /* ignore */ }
      state.token = null; sessionStorage.removeItem('civicai_token'); renderLogin();
    });
    $$('.tabs button').forEach((b) => b.addEventListener('click', () => { state.dashTab = b.dataset.tab; renderDash(); }));
    ({ overview: tabOverview, issues: tabIssues, hotspots: tabHotspots }[state.dashTab])();
  }

  async function tabOverview() {
    const body = $('#tabBody');
    body.innerHTML = '<p><span class="spinner" aria-hidden="true"></span> Loading</p>';
    try {
      const [sum, prio, issues] = await Promise.all([
        api('/api/admin/summary', { auth: true }), api('/api/admin/priorities', { auth: true }),
        api('/api/admin/issues?group=open', { auth: true })
      ]);
      const maxDept = Math.max(1, ...sum.by_department.map((d) => d.n));
      body.innerHTML = `
      <div class="tiles">
        <div class="tile crit"><b>${sum.critical}</b><span>Critical issues</span></div>
        <div class="tile"><b>${sum.unresolved}</b><span>Unresolved</span></div>
        <div class="tile"><b>${sum.resolved}</b><span>Resolved</span></div>
        <div class="tile"><b>${sum.duplicates_merged}</b><span>Duplicates merged</span></div>
        <div class="tile"><b>${sum.needs_review}</b><span>Repairs to review</span></div>
      </div>
      <div class="dash-grid">
        <div>
          <div class="panel" style="margin-bottom:1.5rem">
            <h2 style="font-size:1.9rem">Prioritise these ${prio.length} issues today</h2>
            ${prio.length ? `<ol class="prio">${prio.map((p, n) => `<li><button type="button" data-id="${p.id}">
              <span class="rank" aria-hidden="true">${n + 1}</span>
              <span class="ttl">${p.icon} ${esc(p.category_label)} ${badge(p.severity_level)} <span>${p.severity}/100</span></span>
              <span class="sub">${esc(p.severity_reason)}</span></button></li>`).join('')}</ol>` : '<p class="empty">No open issues. Nothing needs attention.</p>'}
          </div>
          <div class="panel">
            <h2 style="font-size:1.9rem">Open issues by department</h2>
            <div class="bars">${sum.by_department.map((d) => `<div class="bar-row"><span>${esc(d.name.replace(/ \(.*\)/, ''))}</span><i style="width:${Math.round((d.n / maxDept) * 100)}%"></i><span>${d.n}</span></div>`).join('') || '<p class="small">No open issues.</p>'}</div>
          </div>
        </div>
        <div class="panel">
          <h2 style="font-size:1.9rem">Map of open issues</h2>
          <div id="dmap" class="map tall" role="application" aria-label="Map of open issues"></div>
          <div class="legend" aria-label="Legend">${['critical', 'high', 'medium', 'low'].map(badge).join('')}</div>
        </div>
      </div>`;
      const map = makeMap($('#dmap'), state.config.center, 14);
      const pts = [];
      issues.forEach((p) => {
        pts.push([p.lat, p.lng]);
        L.marker([p.lat, p.lng], { icon: pinIcon(p.severity_level, p.severity), title: `${p.category_label}, severity ${p.severity}` })
          .addTo(map).on('click', () => openDrawer(p.id));
      });
      if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
      $$('.prio button').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.id)));
    } catch (e) { if (!authFail(e)) body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  }

  async function tabIssues() {
    const body = $('#tabBody');
    const f = state.filters;
    body.innerHTML = `
      <div class="filters">
        <div class="field"><label for="fg">Show</label><select id="fg"><option value="open">Open issues</option><option value="done">Repaired / verified</option><option value="">Everything</option></select></div>
        <div class="field"><label for="fl">Severity</label><select id="fl"><option value="">All levels</option>${['critical', 'high', 'medium', 'low'].map((l) => `<option value="${l}">${LEVEL_LABEL[l]}</option>`).join('')}</select></div>
        <div class="field"><label for="fc">Problem type</label><select id="fc"><option value="">All types</option>${state.config.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('')}</select></div>
      </div>
      <div id="tbl"><p><span class="spinner" aria-hidden="true"></span> Loading</p></div>`;
    $('#fg').value = f.group; $('#fl').value = f.level; $('#fc').value = f.category;
    const load = async () => {
      f.group = $('#fg').value; f.level = $('#fl').value; f.category = $('#fc').value;
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
      try {
        const rows = await api('/api/admin/issues?' + q, { auth: true });
        $('#tbl').innerHTML = rows.length ? `
        <div class="table-wrap"><table>
          <caption class="vh">Issues sorted by severity</caption>
          <thead><tr><th scope="col">Severity</th><th scope="col">Problem</th><th scope="col">Reports</th><th scope="col">Department</th><th scope="col">Status</th><th scope="col">Last report</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td>${badge(r.severity_level)} <strong>${r.severity}</strong></td>
            <td><button class="rowbtn" type="button" data-id="${r.id}">${r.icon} ${esc(r.category_label)}</button></td>
            <td>${r.report_count}</td><td>${esc((r.department || '').replace(/ \(.*\)/, ''))}</td>
            <td>${statusPill(r.status)}</td><td>${esc(ago(r.last_reported_at))}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="panel empty">No issues match these filters. Try a different filter.</div>';
        $$('.rowbtn').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.id)));
      } catch (e) { if (!authFail(e)) $('#tbl').innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
    };
    ['fg', 'fl', 'fc'].forEach((id) => $('#' + id).addEventListener('change', load));
    load();
  }

  async function tabHotspots() {
    const body = $('#tabBody');
    body.innerHTML = '<p><span class="spinner" aria-hidden="true"></span> Loading</p>';
    try {
      const hs = await api('/api/admin/hotspots', { auth: true });
      body.innerHTML = `
      <p class="lead" style="margin-bottom:1.4rem">CivicAI learns from report history: where problems repeat, how recently, and which repairs came back. These areas are likely to fail again.</p>
      <div class="dash-grid">
        <div class="hot">${hs.length ? hs.map((h, n) => `
          <article class="hot-card">
            <h3>Hotspot ${n + 1} ${badge(h.level)} <span>Risk ${h.score}/100</span></h3>
            <p>${esc(h.recommendation)}</p>
            <p class="small">${h.reports} reports, ${h.issues} separate issues, ${h.recent_30d} in the last 30 days, ${h.repeats} repeats</p>
            <button class="btn small-btn" data-fly="${n}" type="button">Show on map</button>
          </article>`).join('') : '<div class="panel empty">Not enough report history yet to spot a pattern. Hotspots appear as reports build up.</div>'}</div>
        <div class="panel"><h2 style="font-size:1.9rem;margin-bottom:1rem">Hotspot map</h2><div id="hmap" class="map tall" role="application" aria-label="Map of predicted hotspots"></div></div>
      </div>`;
      const map = makeMap($('#hmap'), state.config.center, 14);
      const col = { critical: '#B00020', high: '#B34700', medium: '#FFC20E', low: '#13703A' };
      hs.forEach((h, n) => {
        L.circle([h.lat, h.lng], { radius: 300, color: col[h.level], weight: 4, dashArray: '8 6', fillColor: col[h.level], fillOpacity: 0.25 })
          .addTo(map).bindPopup(`<strong>Hotspot ${n + 1}</strong><br>${esc(h.top_category_label)}, risk ${h.score}/100`);
      });
      if (hs.length) map.fitBounds(hs.map((h) => [h.lat, h.lng]), { padding: [50, 50], maxZoom: 15 });
      $$('[data-fly]').forEach((b) => b.addEventListener('click', () => { const h = hs[b.dataset.fly]; map.setView([h.lat, h.lng], 16); $('#hmap').scrollIntoView({ block: 'center' }); }));
    } catch (e) { if (!authFail(e)) body.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  }

  // ---------- issue drawer ----------
  let drawerOpener = null;
  function closeDrawer() {
    $$('.backdrop, .drawer').forEach((n) => n.remove());
    document.removeEventListener('keydown', escClose);
    if (drawerOpener && document.contains(drawerOpener)) drawerOpener.focus();
    drawerOpener = null;
  }
  const escClose = (e) => { if (e.key === 'Escape') closeDrawer(); };

  async function openDrawer(id) {
    drawerOpener = document.activeElement;
    $$('.backdrop, .drawer').forEach((n) => n.remove());
    const bd = document.createElement('div'); bd.className = 'backdrop'; bd.addEventListener('click', closeDrawer);
    const dr = document.createElement('aside'); dr.className = 'drawer';
    dr.setAttribute('role', 'dialog'); dr.setAttribute('aria-modal', 'true'); dr.setAttribute('aria-label', 'Issue details');
    dr.innerHTML = '<p><span class="spinner" aria-hidden="true"></span> Loading</p>';
    document.body.append(bd, dr);
    document.addEventListener('keydown', escClose);
    try {
      const { issue: i, reports, events } = await api('/api/admin/issues/' + id, { auth: true });
      const ctx = i.context || {};
      const places = [
        ctx.road_type === 'main_road' ? 'Main road' : ctx.road_type === 'busy_market' ? 'Busy market area' : 'Local street',
        ...(ctx.schools || []).map((s) => `${s.name} (${s.distance_m} m)`),
        ...(ctx.hospitals || []).map((s) => `${s.name} (${s.distance_m} m)`)
      ];
      const open = !['resolved', 'verified'].includes(i.status);
      dr.innerHTML = `
        <div class="drawer-head">
          <div><h2>${i.icon} ${esc(i.category_label)}</h2><div style="margin-top:.6rem">${statusPill(i.status)}</div></div>
          <button class="btn small-btn" id="dclose" type="button">Close</button>
        </div>
        <section>${gauge(i.severity, i.severity_level)}
          <dl class="facts">
            <dt>Why</dt><dd>${esc(i.severity_reason)}</dd>
            <dt>Department</dt><dd>${esc(i.department)}</dd>
            <dt>Reports</dt><dd>${i.report_count} (first ${esc(ago(i.first_reported_at))})</dd>
            <dt>Surroundings</dt><dd>${esc(places.join(', '))}</dd>
            <dt>Verification</dt><dd>${esc(VERIFY_LABEL[i.verification_status] || i.verification_status)}${i.verification_note ? ': ' + esc(i.verification_note) : ''}</dd>
            <dt>Assigned to</dt><dd>${esc(i.assignee || 'Nobody yet')}</dd>
            <dt>Location</dt><dd>${i.lat.toFixed(5)}, ${i.lng.toFixed(5)}</dd>
          </dl>
        </section>
        <section><h3>Photos</h3><div class="photos">
          <figure>${i.cover_photo ? `<img src="${esc(i.cover_photo)}" alt="Original report photo">` : '<div class="noimg">No photo (demo data)</div>'}<figcaption>Before</figcaption></figure>
          <figure>${i.after_photo ? `<img src="${esc(i.after_photo)}" alt="After repair photo">` : '<div class="noimg">No after photo</div>'}<figcaption>After</figcaption></figure>
        </div></section>
        <section><h3>Update this issue</h3>
          <div class="field-row">
            <div class="field"><label for="dst">Status</label><select id="dst">${['submitted', 'assigned', 'in_progress', 'resolved', 'verified', 'reopened'].map((s) => `<option value="${s}"${s === i.status ? ' selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}</select></div>
            <div class="field"><label for="das">Assign to</label><input id="das" type="text" maxlength="80" value="${esc(i.assignee || '')}" placeholder="Crew or officer"></div>
          </div>
          <div class="field"><label for="dnt">Note (shown in the public timeline)</label><input id="dnt" type="text" maxlength="500"></div>
          <button class="btn primary" id="dsave" type="button">Save update</button>
        </section>
        ${open ? `<section><h3>Mark as repaired</h3>
          <p class="hint" style="margin-bottom:.8rem">Add an after photo and CivicAI compares it with the original right away. Without a photo, the citizen is asked to confirm.</p>
          <div class="field"><label for="dph">After photo (optional)</label><input id="dph" type="file" accept="image/jpeg,image/png,image/webp"></div>
          <button class="btn accent" id="dres" type="button">Mark as repaired</button></section>` : ''}
        <section><h3>Citizen reports (${reports.length})</h3>
          <ul class="rep-list">${reports.slice(-10).reverse().map((r) => `<li><strong>${esc(r.tracking_id)}</strong> ${esc(fmtDate(r.created_at))}${r.description ? '<br>' + esc(r.description) : ''}${r.reporter_name || r.contact ? `<br><span class="small">${esc([r.reporter_name, r.contact].filter(Boolean).join(', '))}</span>` : ''}${r.merge_note ? `<br><span class="small">Merged: ${esc(r.merge_note)}</span>` : ''}</li>`).join('')}</ul>
          ${reports.length > 10 ? `<p class="small" style="margin-top:.5rem">Showing the latest 10 of ${reports.length}.</p>` : ''}
        </section>
        <section><h3>Timeline</h3><ul class="timeline">${events.slice().reverse().map((e) => `<li><time>${esc(fmtDate(e.created_at))} by ${esc(e.actor)}</time><p>${esc(e.note || e.type)}</p></li>`).join('')}</ul></section>`;
      $('#dclose').addEventListener('click', closeDrawer);
      $('#dclose').focus();
      $('#dsave').addEventListener('click', async () => {
        try {
          await api('/api/admin/issues/' + id, { method: 'PATCH', auth: true, json: { status: $('#dst').value, assignee: $('#das').value, note: $('#dnt').value || undefined } });
          toast('Issue updated'); closeDrawer(); renderDash();
        } catch (e) { toast(e.message); }
      });
      const res = $('#dres');
      if (res) res.addEventListener('click', async () => {
        res.disabled = true; res.textContent = 'Working...';
        try {
          const fd = new FormData(); const f = $('#dph').files[0];
          if (f) fd.append('photo', await shrink(f));
          const r = await api(`/api/admin/issues/${id}/resolve`, { method: 'POST', auth: true, form: fd });
          toast(r.verdict === 'incomplete' ? 'AI flagged a possible incomplete repair' : r.verdict === 'verified' ? 'Repair verified by AI' : 'Marked as repaired');
          closeDrawer(); renderDash();
        } catch (e) { toast(e.message); res.disabled = false; res.textContent = 'Mark as repaired'; }
      });
    } catch (e) {
      if (!authFail(e)) dr.innerHTML = `<div class="notice bad">${esc(e.message)}</div><button class="btn" id="dclose" type="button">Close</button>`;
      else closeDrawer();
      const c = $('#dclose'); if (c) c.addEventListener('click', closeDrawer);
    }
  }

  route();
})();
