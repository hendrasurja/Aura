/* Aura for iPhone — Mira in your pocket. Talks to Gemini (with Google Search) and Groq (Whisper + Orpheus)
   directly from the phone; keys never leave the device except to those two services. */
(function () {
  'use strict';
  const C = window.AuraCore;
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('aura.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('aura.' + k, JSON.stringify(v)); } catch {} },
  };

  // ───────── settings ─────────
  const DEFAULTS = { name: '', geminiKey: '', groqKey: '', model: C.MODELS[0], speak: true, voice: 'hannah', style: 'soft-cheerful', sounds: true, persona: C.DEFAULT_PERSONA,
    whatsapp: true, contacts: '', gcid: '', calendar: false, calAdd: true };
  let S = { ...DEFAULTS, ...store.get('settings', {}) };
  const saveSettings = () => store.set('settings', S);
  let history = store.get('history', []);           // [{ role: 'user'|'model', text, sources? }]
  let memory = store.get('memory', []);              // ['fact', …]

  // ───────── audio (iOS needs a tap before any sound) ─────────
  let ctx = null;
  function unlockAudio() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
    if (ctx.state === 'suspended') ctx.resume();
    const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
  }
  document.addEventListener('touchstart', unlockAudio, { passive: true });
  document.addEventListener('pointerdown', unlockAudio);
  function playBuffer(buf, volume = 1) {
    return new Promise((resolve) => {
      if (!ctx) return resolve();
      const src = ctx.createBufferSource(); const g = ctx.createGain(); g.gain.value = volume;
      src.buffer = buf; src.connect(g).connect(ctx.destination); src.onended = resolve; src.start(0);
    });
  }
  async function decode(arrayBuf) { if (!ctx) unlockAudio(); return ctx.decodeAudioData(arrayBuf.slice(0)); }

  // ───────── Mira's animation ─────────
  const imgs = [$('gif-a'), $('gif-b')];
  let front = 0, gestureTimer = null, speaking = false, restart = 0, current = 'blink';
  function show(name) {
    const next = imgs[1 - front];
    const url = `gifs/${name}.gif?r=${++restart}`;     // query makes the GIF start from its first frame
    next.onload = () => { next.classList.add('show'); imgs[front].classList.remove('show'); front = 1 - front; placeBubble(); };
    next.src = url; current = name;
  }
  function gesture(name) {
    if (!C.GIF_MS[name] || speaking) return;
    if (name === 'dance' && Math.random() < 0.5) name = 'dance_b';
    clearTimeout(gestureTimer); show(name);
    gestureTimer = setTimeout(() => { if (!speaking) show('blink'); }, C.GIF_MS[name]);
    sound(name);
  }
  function startSpeaking() { speaking = true; clearTimeout(gestureTimer); if (current !== 'speak') show('speak'); }
  function stopSpeaking() { speaking = false; show('blink'); }

  // tap her for a reaction
  const reactions = ['surprise', 'tease', 'shy', 'laugh', 'wave'];
  $('stage').addEventListener('click', (e) => {
    if (e.target.closest('#bubble')) return;
    const r = $('mira').getBoundingClientRect();
    if (e.clientY < r.top || speaking) return;
    $('mira').classList.add('tap'); setTimeout(() => $('mira').classList.remove('tap'), 120);
    gesture(reactions[Math.floor(Math.random() * reactions.length)]);
  });

  // ───────── speech bubble ─────────
  const bubble = $('bubble');
  const MAX = 150;
  let typed = '', target = '', done = false, typer = null, hideTimer = null, actionsHtml = '';
  function placeBubble() {
    const img = imgs[front]; const r = img.getBoundingClientRect(); const st = $('stage').getBoundingClientRect();
    if (!r.height) return;
    const head = r.top + r.height * 0.165 - st.top;            // her head is ~16.5% down the full-body image
    if (bubble.classList.contains('has-act')) {                // cards with buttons may come down over her
      bubble.style.bottom = 'auto'; bubble.style.top = '6px'; bubble.style.maxHeight = `${Math.round(st.height * 0.62)}px`; return;
    }
    bubble.style.top = 'auto';
    bubble.style.bottom = `${st.height - head + 12}px`;
    bubble.style.maxHeight = `${Math.max(70, head - 16)}px`;           // never taller than the space above her head
  }
  window.addEventListener('resize', placeBubble);
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function say(html, seconds) { clearInterval(typer); typer = null; bubble.classList.remove('has-act'); bubble.innerHTML = html; bubble.classList.add('show'); placeBubble(); if (seconds) hideIn(seconds); else clearTimeout(hideTimer); }
  function hide() { bubble.classList.remove('show'); clearInterval(typer); typer = null; }
  function hideIn(sec) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, sec * 1000); }
  const dots = () => say('<span class="dots"><span></span><span></span><span></span></span>');
  function render() {
    let limit = MAX;
    for (let guard = 0; guard < 20; guard++) {                 // shorten until it fits the space above her head
      let t = typed, more = false;
      if (t.length > limit) { t = t.slice(0, limit).replace(/\s+\S*$/, ''); more = true; }
      if (done && target.length > limit) more = true;
      bubble.classList.toggle('has-act', !!(done && actionsHtml));
      bubble.innerHTML = esc(t) + (more ? `${/[.!?…]$/.test(t) ? '' : '…'} <span class="more">more</span>` : '') + (done ? actionsHtml : '');
      bubble.classList.add('show'); placeBubble();
      if (bubble.scrollHeight <= bubble.clientHeight + 12 || limit < 40) break;   // +12: the tail sticks out below
      limit = Math.min(limit, t.length) - 12;
    }
  }
  function stream(text, isDone) {
    target = C.plain(text); done = !!isDone; clearTimeout(hideTimer);
    if (!typer) typer = setInterval(() => {
      if (typed.length < Math.min(target.length, MAX + 1)) { typed = target.slice(0, typed.length + 2); render(); }
      else if (done) { clearInterval(typer); typer = null; render(); }
    }, 60);
  }
  const readTime = (t) => Math.min(25, 3 + C.plain(t).slice(0, MAX).split(/\s+/).length * 0.28);
  bubble.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) { e.stopPropagation(); runAction(b.dataset.act, Number(b.dataset.i)); return; }
    if (e.target.closest('a.btn')) { setTimeout(hide, 600); return; }        // WhatsApp link opens by itself
    if (e.target.classList.contains('more')) openHistory(); else hide();
  });

  // ───────── conversation with Gemini ─────────
  let busy = false;
  let calCtx = null;                                   // { events, canAdd } while the calendar is connected
  async function geminiStream(useSearch, onChunk, model) {
    const contents = history.slice(-16).map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] }));
    const body = {
      systemInstruction: { parts: [{ text: C.buildSystemPrompt({ persona: S.persona, userName: S.name, memory, now: new Date().toString(),
        whatsapp: S.whatsapp, contacts: C.parseContacts(S.contacts).map((c) => c.name), calendar: calCtx }) }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
    };
    if (useSearch) body.tools = [{ google_search: {} }];
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || S.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': S.geminiKey.trim() }, body: JSON.stringify(body),
      });
    } catch { throw { status: 0 }; }
    if (!res.ok) throw { status: res.status, body: await res.text().catch(() => '') };
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const r = C.parseSSE(buf); buf = r.rest;
      for (const ev of r.events) onChunk(C.eventPayload(ev));
    }
    if (buf.trim()) for (const ev of C.parseSSE(buf + '\n\n').events) onChunk(C.eventPayload(ev));
  }

  async function ask(text) {
    if (!text || busy) return;
    if (!S.geminiKey) { openSettings(); return; }
    if (S.calendar && S.gcid) {
      const ok = await refreshCalendar();
      if (ok === 'renewing') { sessionStorage.setItem('aura.pending', text); return; }   // back after Google, then we ask
    } else calCtx = null;
    busy = true; $('btn-mic').disabled = true;
    history.push({ role: 'user', text }); store.set('history', history);
    dots(); if (!speaking) { clearTimeout(gestureTimer); show('think'); }
    let raw = '', sources = [], gestured = false;
    actionsHtml = ''; pendingActions = [];
    typed = ''; target = ''; done = false;
    const onChunk = (p) => {
      raw += p.text; for (const s of p.sources) if (!sources.some((x) => x.uri === s.uri)) sources.push(s);
      const t = C.splitTags(raw);
      if (t.gesture && !gestured) { gestured = true; gesture(t.gesture); }
      if (t.visible) stream(t.visible, false);
    };
    const LITE = 'gemini-flash-lite-latest';
    const today = new Date().toDateString();
    let model = store.get('fallbackDay', '') === today && S.model !== LITE ? LITE : S.model;   // already switched earlier today
    let waited = false, useSearch = store.get('noSearchDay', '') !== today;
    for (;;) {
      try { await geminiStream(useSearch, onChunk, model); break; }
      catch (err) {
        if (raw) break;                                       // partial answer: keep what we have
        if (err.status === 400 && useSearch && !/API key/i.test(err.body || '')) { useSearch = false; continue; }  // model without search
        if (err.status === 429) {
          const q = C.quotaInfo(err.body);
          if (q.search && useSearch) {                        // Google Search allowance used up: answer without it today
            useSearch = false; store.set('noSearchDay', today); continue;
          }
          if (q.perDay && model !== LITE) {                   // daily quota for this model gone: Flash-Lite has its own
            model = LITE; store.set('fallbackDay', today);
            say('Today\'s free Gemini Flash limit is used up, so I\'m switching to Flash-Lite…'); await new Promise((r) => setTimeout(r, 1200)); dots();
            continue;
          }
          if (!q.perDay && !waited) {                         // per-minute limit: wait as long as Google asks
            waited = true;
            for (let s = q.wait || 20; s > 0; s--) { say(`I'm out of breath (Gemini's per-minute limit). Trying again in ${s}s…`); await new Promise((r) => setTimeout(r, 1000)); }
            dots(); continue;
          }
          say(`<span class="err">${esc(q.perDay ? `Today's free Gemini limit is used up${model === LITE ? ', on Flash-Lite too' : ''}. It resets at ${C.quotaResetText()}. Turning on billing in Google AI Studio lifts the limit.` : C.friendlyError(429))}</span>`, 12);
          if (!speaking) show('blink');
          history.pop(); store.set('history', history);
          busy = false; $('btn-mic').disabled = false; return;
        }
        say(`<span class="err">${esc(C.friendlyError(err.status, err.body))}</span>`, 9);
        if (!speaking) show('blink');
        history.pop(); store.set('history', history);
        busy = false; $('btn-mic').disabled = false; return;
      }
    }
    const t = C.splitTags(raw);
    if (!gestured && !speaking) show('blink');
    for (const m of t.memories) if (!memory.includes(m)) memory.push(m);
    memory = memory.slice(-60); store.set('memory', memory);
    pendingActions = t.actions.filter((a) => (a.type === 'whatsapp' && S.whatsapp) || (a.type === 'calendar' && calCtx && calCtx.canAdd));
    actionsHtml = pendingActions.map(actionCard).join('');
    const notes = pendingActions.map((a) => a.type === 'whatsapp' ? `\n[WhatsApp draft to ${a.to}: ${a.text}]` : `\n[Calendar event prepared: ${a.title}, ${a.start}${a.end ? '–' + a.end : ''}]`).join('');
    history.push({ role: 'model', text: t.visible + notes, sources }); history = history.slice(-80); store.set('history', history);
    stream(t.visible || (pendingActions.length ? 'Here you go:' : ''), true);
    busy = false; $('btn-mic').disabled = false;
    if (!t.visible && !pendingActions.length) { hide(); return; }
    const spoke = S.speak && t.visible && (await speak(t.visible));
    if (pendingActions.length) hideIn(45); else if (!spoke) hideIn(readTime(t.visible)); else hideIn(2.5);
  }

  // ───────── her voice (Groq Orpheus) ─────────
  async function tts(text, style) {
    const prefix = C.STYLES[style] || '';
    const res = await fetch('https://api.groq.com/openai/v1/audio/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.groqKey.trim()}` },
      body: JSON.stringify({ model: 'canopylabs/orpheus-v1-english', voice: S.voice, input: prefix ? `${prefix} ${text}` : text, response_format: 'wav' }),
    });
    if (!res.ok) throw { status: res.status, body: await res.text().catch(() => '') };
    return decode(await res.arrayBuffer());
  }
  async function speak(text) {
    const chunks = C.splitForTts(text);
    if (!chunks.length) return false;
    if (S.groqKey && ctx) {
      try {
        const jobs = chunks.map((c) => tts(c, S.style));     // fetch together, play in order
        startSpeaking();
        for (const j of jobs) await playBuffer(await j);
        stopSpeaking(); return true;
      } catch (e) { console.warn('voice failed', e); if (speaking) stopSpeaking(); }
    }
    if ('speechSynthesis' in window) {                        // fallback: the iPhone's own voice
      return new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(C.plain(text).slice(0, 600));
        u.onend = u.onerror = () => { stopSpeaking(); resolve(true); };
        startSpeaking(); speechSynthesis.speak(u);
      });
    }
    return false;
  }

  // ───────── little sounds in her voice, made once and kept on the phone ─────────
  let lastSound = 0;
  async function sound(name) {
    if (!S.sounds || !S.groqKey || !C.SOUND_LINES[name] || speaking || !ctx) return;
    if (Date.now() - lastSound < 8000) return;
    lastSound = Date.now();
    try {
      const key = new Request(`sounds/${S.voice}/${name}.wav`);
      const cache = await caches.open('aura-sounds');
      let res = await cache.match(key);
      if (!res) {
        const [line, style] = C.SOUND_LINES[name];
        const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.groqKey.trim()}` },
          body: JSON.stringify({ model: 'canopylabs/orpheus-v1-english', voice: S.voice, input: `${C.STYLES[style] || ''} ${line}`.trim(), response_format: 'wav' }),
        });
        if (!r.ok) return;
        await cache.put(key, r.clone()); res = r;
      }
      if (!speaking) playBuffer(await decode(await res.arrayBuffer()), 0.8);
    } catch (e) { console.warn('sound', e); }
  }

  // ───────── hold to talk (Groq Whisper) ─────────
  let rec = null, chunks = [], recStart = 0, recMime = '';
  async function startRec() {
    if (busy || rec) return;
    if (!S.groqKey) { say('Add your Groq key in Settings so I can hear you.', 6); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recMime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
      rec = new MediaRecorder(stream, recMime ? { mimeType: recMime } : undefined);
      chunks = []; recStart = Date.now();
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); finishRec(); };
      rec.start(200);
      $('btn-mic').classList.add('recording'); $('hint').textContent = 'Listening… release to send';
      say('<span class="rec"></span>Listening…');
    } catch (e) {
      rec = null; say(`<span class="err">I can't use the microphone. Allow it in Settings > Safari > Microphone (or for Aura).</span>`, 9);
    }
  }
  function stopRec() { if (rec && rec.state !== 'inactive') rec.stop(); $('btn-mic').classList.remove('recording'); $('hint').textContent = 'Hold to talk'; }
  async function finishRec() {
    const dur = Date.now() - recStart; const mime = rec && rec.mimeType || recMime || 'audio/mp4'; rec = null;
    if (dur < 450) { say('Hold the button while you talk, then let go.', 4); return; }
    dots();
    try {
      const blob = new Blob(chunks, { type: mime });
      const fd = new FormData();
      fd.append('file', blob, /mp4|aac|m4a/.test(mime) ? 'speech.m4a' : 'speech.webm');
      fd.append('model', 'whisper-large-v3-turbo'); fd.append('response_format', 'json'); fd.append('temperature', '0');
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${S.groqKey.trim()}` }, body: fd });
      if (!r.ok) { say(`<span class="err">${r.status === 429 ? 'Groq\'s free limit: try again in a minute.' : r.status === 401 ? 'My Groq key was refused. Check it in Settings.' : 'I couldn\'t hear that (' + r.status + ').'}</span>`, 8); return; }
      const text = String((await r.json()).text || '').trim();
      if (!text) { say('I didn\'t catch that. Try again?', 4); return; }
      say(`<span class="heard">“${esc(text)}”</span>`);
      setTimeout(() => ask(text), 500);
    } catch { say('<span class="err">I couldn\'t reach Groq to hear you.</span>', 8); }
  }
  const mic = $('btn-mic');
  mic.addEventListener('pointerdown', (e) => { e.preventDefault(); unlockAudio(); startRec(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => mic.addEventListener(ev, () => { if (rec) stopRec(); }));
  mic.addEventListener('contextmenu', (e) => e.preventDefault());

  // typing
  $('btn-keyboard').addEventListener('click', () => { $('app').classList.toggle('typing'); if ($('app').classList.contains('typing')) $('text-input').focus(); });
  $('text-row').addEventListener('submit', (e) => {
    e.preventDefault(); const v = $('text-input').value.trim(); if (!v) return;
    $('text-input').value = ''; $('text-input').blur(); ask(v);
  });

  // ───────── WhatsApp drafts and calendar events ─────────
  let pendingActions = [];
  function actionCard(a, i) {
    if (a.type === 'whatsapp') {
      const l = C.whatsappLink(a.to, a.text, C.parseContacts(S.contacts));
      return `<div class="act"><span class="draft">“${esc(a.text)}”</span><a class="btn" href="${l.url}" target="_blank" rel="noopener">${l.direct ? `Send to ${esc(l.name)} on WhatsApp` : 'Open WhatsApp'}</a></div>`;
    }
    const st = new Date(C.localToRfc(a.start) || a.start);
    const when = isNaN(st) ? a.start : st.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `<div class="act"><span class="draft">${esc(a.title)} · ${esc(when)}${a.location ? ' · ' + esc(a.location) : ''}</span>` +
      `<button class="btn" data-act="cal-add" data-i="${i}">Add to calendar</button><button class="btn ghost" data-act="cancel" data-i="${i}">No thanks</button></div>`;
  }
  async function runAction(kind, i) {
    const a = pendingActions[i];
    if (kind === 'cancel' || !a) { hide(); return; }
    if (kind === 'cal-add') {
      const start = C.localToRfc(a.start);
      let end = C.localToRfc(a.end);
      if (!start) { say('<span class="err">I couldn\'t read that time. Try asking again with a date and time.</span>', 7); return; }
      if (!end) end = C.localToRfc(new Date(new Date(start).getTime() + 3600e3 - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16));
      say('<span class="dots"><span></span><span></span><span></span></span>');
      try {
        const r = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: a.title, location: a.location || undefined, start: { dateTime: start }, end: { dateTime: end } }),
        });
        if (!r.ok) throw new Error(String(r.status));
        calCache = 0; gesture('celebrate'); say(esc(`Added “${a.title}” to your calendar!`), 5);
      } catch (e) { say(`<span class="err">I couldn't add it (${esc(e.message)}). Try reconnecting the calendar in Settings.</span>`, 8); }
    }
  }

  // ───────── Google Calendar (sign-in straight from the phone, no server) ─────────
  const calScope = () => S.calAdd ? 'https://www.googleapis.com/auth/calendar.events' : 'https://www.googleapis.com/auth/calendar.readonly';
  const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');
  let calCache = 0;
  function calConnect(silent) {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem('aura.oauthState', state);
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: S.gcid.trim(), redirect_uri: redirectUri(), response_type: 'token', scope: calScope(),
      include_granted_scopes: 'true', state, prompt: silent ? 'none' : 'consent',
    });
  }
  function calToken() { const t = store.get('calToken', null); return t && t.exp > Date.now() && t.scope === calScope() ? t.token : null; }
  async function calFetch(url, opts = {}) {
    const tok = calToken(); if (!tok) throw new Error('not signed in');
    return fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } });
  }
  async function refreshCalendar() {
    if (!calToken()) { calConnect(true); return 'renewing'; }        // token expired: quick silent trip to Google
    if (calCtx && Date.now() - calCache < 5 * 60e3) return true;
    try {
      const now = new Date(), until = new Date(now.getTime() + 7 * 864e5);
      const r = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
        timeMin: now.toISOString(), timeMax: until.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '30' }));
      if (r.status === 401) { store.set('calToken', null); calConnect(true); return 'renewing'; }
      if (!r.ok) throw new Error(r.status);
      calCtx = { events: C.formatEvents((await r.json()).items || []), canAdd: S.calAdd }; calCache = Date.now();
      return true;
    } catch (e) { console.warn('calendar', e); calCtx = null; return false; }
  }
  function handleOAuthReturn() {
    if (!location.hash.includes('state=')) return false;
    const h = new URLSearchParams(location.hash.slice(1));
    window.history.replaceState(null, '', location.pathname);
    if (h.get('state') !== sessionStorage.getItem('aura.oauthState')) return false;
    if (h.get('access_token')) {
      store.set('calToken', { token: h.get('access_token'), exp: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000 - 60e3, scope: calScope() });
      S.calendar = true; saveSettings();
      const pending = sessionStorage.getItem('aura.pending'); sessionStorage.removeItem('aura.pending');
      if (pending) setTimeout(() => ask(pending), 600);
      else setTimeout(() => { gesture('celebrate'); say('Your Google Calendar is connected!', 5); }, 800);
    } else if (h.get('error')) {
      sessionStorage.removeItem('aura.pending');
      if (h.get('error') === 'access_denied') { S.calendar = false; saveSettings(); }
      setTimeout(() => say(esc(h.get('error') === 'access_denied' ? 'Okay, I won\'t use your calendar.' : 'I need you to reconnect your calendar: Settings > Connect Google Calendar.'), 8), 800);
    }
    return true;
  }
  function calStatus() {
    const el = $('cal-status'), on = S.calendar && S.gcid;
    el.textContent = on ? (calToken() ? 'Connected' : 'Connected (signs in again when needed)') : 'Not connected';
    el.classList.toggle('on', !!on);
    $('btn-cal').textContent = on ? 'Disconnect Google Calendar' : 'Connect Google Calendar';
  }
  $('btn-cal').addEventListener('click', () => {
    readSettings();
    if (S.calendar) { S.calendar = false; store.set('calToken', null); calCtx = null; saveSettings(); calStatus(); return; }
    if (!S.gcid) { alert('First paste your Google OAuth Client ID (see the setup guide).'); return; }
    calConnect(false);
  });

  // ───────── conversation sheet ─────────
  function openHistory() {
    const list = $('history-list'); list.innerHTML = '';
    if (!history.length) list.innerHTML = '<p class="empty">No conversation yet. Hold the button and say hi!</p>';
    for (const m of history) {
      const d = document.createElement('div'); d.className = `msg ${m.role}`; d.textContent = m.text;
      if (m.sources && m.sources.length) {
        const s = document.createElement('span'); s.className = 'src'; s.textContent = 'Sources:';
        for (const x of m.sources.slice(0, 5)) { const a = document.createElement('a'); a.href = x.uri; a.target = '_blank'; a.rel = 'noopener'; a.textContent = x.title; s.appendChild(a); }
        d.appendChild(s);
      }
      list.appendChild(d);
    }
    $('history').hidden = false; list.scrollTop = list.scrollHeight;
  }
  $('btn-history').addEventListener('click', openHistory);
  $('btn-clear').addEventListener('click', () => { if (confirm('Clear the conversation? (What she remembers about you stays.)')) { history = []; store.set('history', history); openHistory(); } });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.sheet').hidden = true; if (b.closest('#settings')) readSettings(); }));

  // ───────── settings sheet ─────────
  function fillSelect(el, items, labels) { el.innerHTML = items.map((v, i) => `<option value="${v}">${labels ? labels[i] : v}</option>`).join(''); }
  fillSelect($('s-model'), C.MODELS, ['Gemini Flash (default)', 'Gemini Flash Latest', 'Gemini Flash-Lite (higher free limits)']);
  fillSelect($('s-voice'), C.VOICES, C.VOICES.map((v) => v[0].toUpperCase() + v.slice(1)));
  fillSelect($('s-style'), Object.keys(C.STYLES), ['Natural', 'Softly cheerful', 'Cheerful', 'Warm', 'Friendly', 'Whisper']);
  function renderMemory() {
    const ul = $('s-memory'); ul.innerHTML = '';
    if (!memory.length) { ul.innerHTML = '<li style="color:var(--sub);list-style:none;margin-left:-18px">Nothing yet. Tell her about yourself!</li>'; return; }
    memory.forEach((m, i) => { const li = document.createElement('li'); li.textContent = m; const b = document.createElement('button'); b.textContent = 'forget'; b.onclick = () => { memory.splice(i, 1); store.set('memory', memory); renderMemory(); }; li.appendChild(b); ul.appendChild(li); });
  }
  function openSettings(first) {
    $('welcome').hidden = !first;
    $('s-name').value = S.name; $('s-gemini').value = S.geminiKey; $('s-groq').value = S.groqKey;
    $('s-model').value = S.model; $('s-speak').checked = S.speak; $('s-voice').value = S.voice; $('s-style').value = S.style;
    $('s-sounds').checked = S.sounds; $('s-persona').value = S.persona;
    $('s-wa').checked = S.whatsapp; $('s-contacts').value = S.contacts; $('s-gcid').value = S.gcid; $('s-caladd').checked = S.calAdd; calStatus();
    renderMemory(); $('settings').hidden = false;
  }
  function readSettings() {
    const oldVoice = S.voice;
    S = { ...S, name: $('s-name').value.trim(), geminiKey: $('s-gemini').value.trim(), groqKey: $('s-groq').value.trim(), model: $('s-model').value,
      speak: $('s-speak').checked, voice: $('s-voice').value, style: $('s-style').value, sounds: $('s-sounds').checked,
      persona: $('s-persona').value.trim() || C.DEFAULT_PERSONA,
      whatsapp: $('s-wa').checked, contacts: $('s-contacts').value.trim(), gcid: $('s-gcid').value.trim(), calAdd: $('s-caladd').checked };
    saveSettings();
    if (oldVoice !== S.voice) lastSound = 0;
  }
  $('btn-settings').addEventListener('click', () => openSettings(false));
  $('btn-test-voice').addEventListener('click', async () => {
    readSettings(); unlockAudio(); $('settings').hidden = true;
    say(esc(`Hi${S.name ? ' ' + S.name : ''}! This is my voice.`)); await speak(`Hi${S.name ? ' ' + S.name : ''}! This is my voice.`); hideIn(2);
  });

  // ───────── a little daily rhythm ─────────
  function greet() {
    const now = new Date(), h = now.getHours(), today = now.toDateString();
    const lastSeen = store.get('lastSeen', 0); store.set('lastSeen', Date.now());
    if (!S.geminiKey) return;
    const hi = S.name ? `, ${S.name}` : '';
    if (h >= 5 && h < 11 && store.get('morning', '') !== today) { store.set('morning', today); setTimeout(() => { gesture('drink'); say(esc(`Good morning${hi}! Coffee first?`), 6); }, 900); }
    else if (h >= 23 || h < 4) { setTimeout(() => { gesture('yawn'); say(esc('It\'s late… don\'t stay up too long.'), 6); }, 900); }
    else if (Date.now() - lastSeen > 3 * 3600 * 1000) { setTimeout(() => { gesture('wave'); say(esc(`Welcome back${hi}!`), 5); }, 900); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') greet(); });

  // ───────── start ─────────
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  imgs[0].addEventListener('load', placeBubble);
  const backFromGoogle = handleOAuthReturn() !== false;
  if (!S.geminiKey || !S.groqKey) openSettings(true); else if (!backFromGoogle) greet();
  window.Aura = { ask, gesture, say, openSettings, openHistory };   // handy for testing
})();
