/* Aura for iPhone — Mira in your pocket. Talks to Gemini (with Google Search) and Groq (Whisper + Orpheus)
   directly from the phone; keys never leave the device except to those two services. */
(function () {
  'use strict';
  const C = window.AuraCore;
  const APP_BUILD = '14';
  // A missing element (page and script from different versions) must never crash the whole app
  const $ = (id) => document.getElementById(id) || document.createElement('div');
  const store = {
    get: (k, d) => { try { const v = localStorage.getItem('aura.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('aura.' + k, JSON.stringify(v)); } catch {} },
  };

  // ───────── settings ─────────
  const DEFAULTS = { name: '', geminiKey: '', groqKey: '', model: C.MODELS[0], speak: true, voice: 'hannah', style: 'soft-cheerful', sounds: true, persona: C.DEFAULT_PERSONA,
    whatsapp: true, contacts: '', gcid: '', calendar: false, calAdd: true, pool: null, shareCalendar: false, brief: true, briefCity: 'Jakarta', briefLang: 'en', briefMarkets: true };
  let S = { ...DEFAULTS, ...store.get('settings', {}) };
  const saveSettings = () => store.set('settings', S);
  let history = store.get('history', []);           // [{ role: 'user'|'model', text, sources? }]
  let memory = store.get('memory', []);              // ['fact', …]
  // brains: the pool of AI providers, tried in order; resting ones come back by themselves
  const pool = () => { if (!Array.isArray(S.pool)) { S.pool = C.defaultPool(S.model); saveSettings(); } return S.pool; };
  let health = store.get('health', {});
  const setHealth = (h) => { health = h; store.set('health', h); };
  let usage = store.get('usage', null);                          // requests per brain today, on this phone
  const todayKey = () => new Date().toDateString();
  const bumpUse = (id, kind) => { usage = C.usageBump(usage, id, kind, todayKey()); store.set('usage', usage); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  /** What a brain is told about the calendar. Existing events go to backup brains only if allowed; the ability to add an event always goes. */
  function calendarFor(type) {
    if (!S.calendar || !S.gcid) return { off: true };
    const canAdd = !!(S.calAdd && calToken());
    if (calCtx && (type === 'gemini' || S.shareCalendar)) return { ...calCtx, canAdd };
    return { events: null, canAdd, failed: !calCtx };
  }
  const promptFor = (type, search) => C.buildSystemPrompt({ persona: S.persona, userName: S.name, memory, now: new Date().toString(),
    whatsapp: S.whatsapp, contacts: C.parseContacts(S.contacts).map((c) => c.name),
    calendar: calendarFor(type), search });
  async function pump(res, map, onChunk) {
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      buf += dec.decode(value, { stream: true });
      const r = C.parseSSE(buf); buf = r.rest;
      for (const ev of r.events) onChunk(map(ev));
    }
    if (buf.trim()) for (const ev of C.parseSSE(buf + '\n\n').events) onChunk(map(ev));
  }
  async function openaiStream(entry, onChunk) {
    const msgs = [{ role: 'system', content: promptFor('openai', false) },
      ...history.slice(-16).map((m) => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }))];
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.key}` };
    if (/openrouter\.ai/.test(entry.base)) headers['X-Title'] = 'Aura';
    let res;
    try { res = await fetch(`${entry.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: entry.model, messages: msgs, stream: true, temperature: 0.8, max_tokens: 1500 }) }); }
    catch { throw { status: 0 }; }
    if (!res.ok) throw { status: res.status, body: await res.text().catch(() => '') };
    await pump(res, C.openaiPayload, onChunk);
  }
  async function geminiStream(useSearch, onChunk, model, key) {
    const contents = history.slice(-16).map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] }));
    const body = {
      systemInstruction: { parts: [{ text: promptFor('gemini', useSearch) }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
    };
    if (useSearch) body.tools = [{ google_search: {} }];
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || S.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': String(key || S.geminiKey).trim() }, body: JSON.stringify(body),
      });
    } catch { throw { status: 0 }; }
    if (!res.ok) throw { status: res.status, body: await res.text().catch(() => '') };
    await pump(res, C.eventPayload, onChunk);
  }

  async function ask(text) {
    if (!text || busy) return;
    if (!C.available(pool(), S, {}).length) { openSettings(); return; }
    if (S.calendar && S.gcid) {
      const ok = await refreshCalendar();
      if (ok === 'renewing') { sessionStorage.setItem('aura.pending', JSON.stringify({ text, at: Date.now() })); return; }   // back after Google, then we ask
      if (ok === false && calNotice && !C.scheduleIntent(text) && !C.calendarIntent(text) && Date.now() - lastCalNotice > 10 * 60e3) {   // (schedule/add requests explain it themselves)            // tell her person why the calendar isn't working
        lastCalNotice = Date.now(); say(`<span class="err">${esc(calNotice)}</span>`, 14); await sleep(3500);
      }
    } else calCtx = null;
    busy = true; $('btn-mic').disabled = true;
    history.push({ role: 'user', text }); store.set('history', history);
    dots(); if (!speaking) { clearTimeout(gestureTimer); show('think'); }
    actionsHtml = ''; pendingActions = [];
    if (C.briefIntent(text)) { const out = await buildBrief(); await cannedReply({ visible: out.text, gestureName: 'wave', speakText: out.speak }); return; }
    if (C.reminderIntent(text)) {                                                          // "remind me at 3pm to call Budi"
      if (S.calendar && S.gcid && S.calAdd && calToken()) {
        const r = await extractReminder(text);
        if (r && !r.down) {
          if (r.ev) {
            const when = new Date(r.ev.start).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
            const rep = r.ev.repeat !== 'none' ? `, ${C.REPEAT_TEXT.en[r.ev.repeat]}` : '';
            await cannedReply({ visible: `Okay, I prepared a reminder: “${r.ev.title}” on ${when}${rep}. Tap Set reminder to confirm.`, acts: [r.ev], gestureName: 'nod' }); return;
          }
          await cannedReply({ visible: r.missing ? 'Sure! When should I remind you? Give me a day and time.' : 'I couldn\'t work out the time. Try: “Remind me tomorrow at 9 to call Budi”.', gestureName: 'think' }); return;
        }
      } else {
        await cannedReply({ visible: S.calendar ? 'To set reminders I need permission to add events: switch on “Let Mira add events” in Settings > Connections, then connect again.' : 'Reminders ring through your Google Calendar. Connect it in Settings > Connections, then ask me again.', gestureName: 'think' }); return;
      }
    }
    if (S.calendar && S.gcid && S.calAdd && calToken() && C.calendarIntent(text)) {      // "add lunch tomorrow 11 to 1:30": do it ourselves
      const r = await extractEvent(text);
      if (r && !r.down) {                                    // (if every brain is down, carry on so she can say so)
        let visible = null, acts = [];
        if (r.ev) {
          acts = [r.ev];
          const st = new Date(r.ev.start), when = st.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          visible = `Done, I prepared “${r.ev.title}” for ${when}${r.ev.location ? ' at ' + r.ev.location : ''}. Tap Add to calendar to save it.`;
        } else if (/calendar|agenda|kalender|jadwal|schedule|event/i.test(text)) {
          visible = r.missing ? 'Sure! Which day and what time should I put it at?' : 'I couldn\'t work out the day and time from that. Try something like: “Add lunch at Citywalk tomorrow 11:00 to 13:30 to my calendar”.';
        }
        if (visible !== null) { await cannedReply({ visible, acts, gestureName: r.ev ? 'nod' : 'think' }); return; }
      }
    }
    if (S.calendar && S.gcid && C.scheduleIntent(text)) {                          // "what's on tomorrow?": read the calendar ourselves
      if (await answerSchedule(text)) return;
    }

    let raw = '', sources = [], gestured = false;
    actionsHtml = ''; pendingActions = [];
    typed = ''; target = ''; done = false;
    const onChunk = (p) => {
      raw += p.text; for (const s of p.sources) if (!sources.some((x) => x.uri === s.uri)) sources.push(s);
      const t = C.splitTags(raw);
      if (t.gesture && !gestured) { gestured = true; gesture(t.gesture); }
      if (t.visible) stream(t.visible, false);
    };
    const today = new Date().toDateString();
    const failAndReturn = () => { if (!speaking) show('blink'); history.pop(); store.set('history', history); busy = false; $('btn-mic').disabled = false; };
    const attempt = async (entry) => {
      if (entry.type !== 'gemini') return openaiStream(entry, onChunk);
      let useSearch = store.get('noSearchDay', '') !== today;
      for (;;) {
        try { return await geminiStream(useSearch, onChunk, entry.model, entry.key); }
        catch (err) {
          if (raw) throw err;
          if (err.status === 400 && useSearch && !/API key/i.test(err.body || '')) { useSearch = false; continue; }        // model without search
          if (err.status === 429 && useSearch && C.quotaInfo(err.body).search) { useSearch = false; store.set('noSearchDay', today); continue; }  // search allowance used up
          throw err;
        }
      }
    };
    let used = null, waitedOnce = false;
    attempts: for (;;) {
      const order = C.available(pool(), S, health);
      if (!order.length) {
        const back = C.soonestReturn(pool(), S, health);
        if (!waitedOnce && back && back - Date.now() <= 25000) {         // a very short rest: wait for it
          waitedOnce = true;
          for (let s = Math.ceil((back - Date.now()) / 1000); s > 0; s--) { say(`I'm catching my breath… ${s}s`); await sleep(1000); }
          dots(); continue;
        }
        const sum = C.restingSummary(pool(), S, health);
        say(`<span class="err">${esc(sum ? `All my brains are resting right now: ${sum}.` : 'I have no brain to think with. Add a key in Settings.')}</span>`, 15);
        updateVia(); failAndReturn(); return;
      }
      for (const entry of order) {
        try { await attempt(entry); bumpUse(entry.id, 'ok'); used = entry; break attempts; }
        catch (err) {
          if (raw) { bumpUse(entry.id, 'ok'); used = entry; break attempts; }
          bumpUse(entry.id, 'fail');                      // partial answer: keep what we have
          const cls = C.classifyFailure({ status: err.status, body: err.body, type: entry.type, fails: (health[entry.id] || {}).fails || 0 });
          console.warn('brain failed', entry.label, err.status, cls);
          setHealth(C.markFail(health, entry.id, cls)); updateVia();
        }
      }
    }
    setHealth(C.markOk(health, used.id)); updateVia();
    const t = C.splitTags(raw);
    if (!gestured && !speaking) show('blink');
    for (const m of t.memories) if (!memory.includes(m)) memory.push(m);
    memory = memory.slice(-60); store.set('memory', memory);
    const calOk = !!(S.calendar && S.gcid && S.calAdd && calToken());
    pendingActions = t.actions.filter((a) => (a.type === 'whatsapp' && S.whatsapp) || (a.type === 'calendar' && calOk));
    if (t.actions.some((a) => a.type === 'calendar') && !calOk) {          // never leave her claiming something that cannot happen
      t.visible += '\n\n(I couldn\'t prepare that calendar event: ' + (S.calendar ? 'adding events is switched off or your Google sign-in has expired. Check Settings > Connections.' : 'Google Calendar isn\'t connected. Settings > Connections > Connect Google Calendar.') + ')';
    }
    actionsHtml = pendingActions.map(actionCard).join('');
    const notes = pendingActions.map((a) => a.type === 'whatsapp' ? `\n[WhatsApp draft to ${a.to}: ${a.text}]` : `\n[Calendar event prepared: ${a.title}, ${a.start}${a.end ? '–' + a.end : ''}]`).join('');
    history.push({ role: 'model', text: t.visible + notes, sources, via: used.label }); history = history.slice(-80); store.set('history', history);
    stream(t.visible || (pendingActions.length ? 'Here you go:' : ''), true);
    busy = false; $('btn-mic').disabled = false;
    if (!t.visible && !pendingActions.length) { hide(); return; }
    const spoke = S.speak && t.visible && (await speak(t.visible));
    if (pendingActions.length) hideIn(45); else if (!spoke) hideIn(readTime(t.visible)); else hideIn(2.5);
    const wmsg = usageWarn(used);                                  // a quiet heads-up as a free limit gets close
    if (wmsg) setTimeout(() => { if (!busy && !pendingActions.length) say(esc(wmsg), 10); }, ((pendingActions.length ? 0 : spoke ? 3.5 : readTime(t.visible)) + 1) * 1000);
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

  // ───────── which brain is thinking ─────────
  function updateVia() {
    const all = pool().map((e) => C.describe(e, S)).filter((e) => e.enabled && e.key);
    const now = C.available(pool(), S, health)[0];
    $('via').textContent = all.length && now && now.id !== all[0].id ? `via ${now.label}` : '';
  }
  setInterval(() => { updateVia(); }, 20000);

  // ───────── brains in Settings ─────────
  function el(tag, props = {}, kids = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const c of [].concat(kids)) if (c) n.appendChild(c);
    return n;
  }
  const errText = (body) => { try { const j = JSON.parse(body); return String((j.error && (j.error.message || j.error)) || j.message || '').split('\n')[0].slice(0, 140); } catch { return String(body || '').slice(0, 100); } };
  async function testEntry(raw, out, chip) {
    const e = C.describe(raw, S);
    const refreshChip = () => { const st = C.statusOf(raw, S, health); chip.className = `chip ${st.state}`; chip.textContent = st.text; };
    out.className = 'test-out'; out.textContent = 'Testing…';
    try {
      let r;
      if (e.type === 'gemini') {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(e.model)}:generateContent`, { method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': e.key }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say OK' }] }], generationConfig: { maxOutputTokens: 8 } }) });
      } else {
        const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${e.key}` };
        if (/openrouter\.ai/.test(e.base)) headers['X-Title'] = 'Aura';
        r = await fetch(`${e.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: e.model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 8 }) });
      }
      if (r.ok) { setHealth(C.markOk(health, e.id)); out.className = 'test-out ok'; out.textContent = `Working: ${e.model} answered.`; updateVia(); refreshChip(); return; }
      const body = await r.text().catch(() => '');
      const cls = C.classifyFailure({ status: r.status, body, type: e.type, fails: 0 });
      setHealth(C.markFail(health, e.id, cls)); updateVia(); refreshChip();
      out.className = 'test-out bad'; out.textContent = `${cls.why[0].toUpperCase() + cls.why.slice(1)} (${r.status}). ${errText(body)}`;
      if ((r.status === 404 || r.status === 400) && e.type === 'openai') {          // wrong model name: offer the real ones
        try {
          const l = await fetch(`${e.base}/models`, { headers: { Authorization: `Bearer ${e.key}` } });
          const ids = ((await l.json()).data || []).map((m) => m.id).filter((id) => !/whisper|embed|tts|guard|moderation|image|rerank/i.test(id)).slice(0, 12);
          if (ids.length) { out.appendChild(el('div', { class: 'pick', text: 'Models on offer, tap one:' }, ids.map((id) => el('button', { class: 'chipbtn', text: id, onclick: () => { raw.model = id; saveSettings(); renderBrains(); } })))); }
        } catch { /* no list available */ }
      }
    } catch { out.className = 'test-out bad'; out.textContent = 'Couldn\'t reach it from the phone browser. The address may be wrong, or this provider may not allow browser apps.'; setHealth(C.markFail(health, e.id, { k: 'network', ms: 120000, why: 'can\'t be reached from here' })); updateVia(); refreshChip(); }
  }
  function renderBrains() {
    const box = $('brains'); if (!box) return; box.innerHTML = '';
    const list = pool(), now = Date.now();
    const tot = C.usageTotal(usage, todayKey()); $('usage-sum').textContent = `Today on this phone: ${tot.ok} answered${tot.fail ? `, ${tot.fail} limited or failed` : ''}. (Your Mac keeps its own count.)`;
    list.forEach((raw, i) => {
      const e = C.describe(raw, S), st = C.statusOf(raw, S, health, now), m = e.meta;
      const out = el('div', { class: 'test-out' });
      const chip = el('span', { class: `chip ${st.state}`, text: st.text });
      const card = el('div', { class: `brain ${st.state}` }, [
        el('div', { class: 'brain-head' }, [el('b', { text: e.label }), chip]),
        el('div', { class: 'brain-note', text: m.shared ? m.note : e.type === 'gemini' ? 'Uses your Gemini key above. Separate free quota per model.' : m.note }),
      ]);
      { const u = C.usageOf(usage, raw.id, todayKey()), n = u.ok + u.fail, lim = e.limit, hot = lim && n >= lim * 0.8;
        card.appendChild(el('div', { class: `usage${hot ? ' hot' : ''}`, text: `Today: ${u.ok} answered${u.fail ? `, ${u.fail} limited or failed` : ''}${lim ? ` · about ${lim} free per day` : ''}` }));
        card.appendChild(el('input', { type: 'number', min: '1', placeholder: lim ? `Daily limit (about ${lim})` : 'Daily limit (optional)', value: raw.limit ? String(raw.limit) : '', oninput: (ev) => { const v = parseInt(ev.target.value, 10); raw.limit = v > 0 ? v : undefined; saveSettings(); } })); }
      if (e.type === 'openai' && !m.shared) card.appendChild(el('input', { type: 'password', placeholder: 'API key', value: raw.key || '', autocapitalize: 'off', spellcheck: 'false', oninput: (ev) => { raw.key = ev.target.value.trim(); saveSettings(); } }));
      if (raw.kind === 'custom') card.appendChild(el('input', { type: 'text', placeholder: 'Address, e.g. https://api.example.com/v1', value: raw.base || '', autocapitalize: 'off', oninput: (ev) => { raw.base = ev.target.value.trim(); saveSettings(); } }));
      card.appendChild(el('input', { type: 'text', placeholder: 'Model', value: raw.model || e.model, autocapitalize: 'off', spellcheck: 'false', oninput: (ev) => { raw.model = ev.target.value.trim(); if (raw.id === 'gemini') { S.model = raw.model; } saveSettings(); } }));
      const tools = el('div', { class: 'brain-tools' }, [
        el('label', { class: 'mini' }, [el('input', { type: 'checkbox', ...(raw.enabled ? { checked: '' } : {}), onchange: (ev) => { raw.enabled = ev.target.checked; saveSettings(); updateVia(); renderBrains(); } }), el('span', { text: 'On' })]),
        el('button', { text: '▲', 'aria-label': 'Move up', onclick: () => { if (i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; saveSettings(); renderBrains(); updateVia(); } } }),
        el('button', { text: '▼', 'aria-label': 'Move down', onclick: () => { if (i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; saveSettings(); renderBrains(); updateVia(); } } }),
        el('button', { text: 'Test', onclick: () => testEntry(raw, out, chip) }),
        m.keyUrl ? el('a', { href: m.keyUrl, target: '_blank', rel: 'noopener', text: 'Get a key ↗' }) : null,
        raw.id !== 'gemini' ? el('button', { class: 'rm', text: 'Remove', onclick: () => { list.splice(i, 1); saveSettings(); renderBrains(); updateVia(); } }) : null,
      ]);
      card.appendChild(tools); card.appendChild(out); box.appendChild(card);
    });
  }
  const addSel = $('brain-add');
  addSel.innerHTML = '<option value="">Add another brain…</option>' + Object.entries(C.CATALOG).filter(([k]) => k !== 'gemini').map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  addSel.addEventListener('change', () => {
    const kind = addSel.value; if (!kind) return;
    pool().push({ id: `${kind}-${Date.now().toString(36)}`, kind, key: '', enabled: true });
    addSel.value = ''; saveSettings(); renderBrains();
  });

  /** An answer the app wrote itself (no AI): show it like a normal reply, with optional buttons and a short spoken version. */
  async function cannedReply({ visible, acts = [], gestureName = 'nod', speakText = '' }) {
    pendingActions = acts; actionsHtml = acts.map(actionCard).join('');
    history.push({ role: 'model', text: visible + acts.map((a) => `\n[Calendar event prepared: ${a.title}, ${a.start}–${a.end}]`).join(''), via: 'Mira' });
    history = history.slice(-80); store.set('history', history);
    typed = ''; target = ''; done = false; gesture(gestureName); stream(visible, true);
    busy = false; $('btn-mic').disabled = false;
    const spoke = S.speak && speakText ? await speak(speakText) : false;
    hideIn(acts.length ? 45 : spoke ? 4 : Math.min(30, 5 + C.plain(visible).slice(0, 150).split(/\s+/).length * 0.3));
  }
  /** Schedule questions: ask Google for exactly the days mentioned and write the answer here. Returns true when handled. */
  async function answerSchedule(text) {
    const range = C.parseRange(text), lang = C.guessLang(text);
    let r;
    try {
      r = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({
        timeMin: range.start.toISOString(), timeMax: range.end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' }));
    } catch { r = null; }
    if (r && r.status === 401) { store.set('calToken', null); sessionStorage.setItem('aura.pending', JSON.stringify({ text, at: Date.now() })); history.pop(); store.set('history', history); busy = false; $('btn-mic').disabled = false; calConnect(true); return true; }
    if (!r || !r.ok) {
      const why = r ? calErrorText(r.status, await r.text().catch(() => '')) : calErrorText(0, '');
      await cannedReply({ visible: `I couldn't read your calendar. ${why}`, gestureName: 'sad' }); return true;
    }
    const out = C.formatSchedule((await r.json()).items || [], range, { lang, free: C.isFreeQuestion(text) });
    await cannedReply({ visible: out.text, gestureName: 'nod', speakText: out.speak });
    return true;
  }

  // ───────── adding calendar events without relying on the AI to follow instructions ─────────
  async function oneShot(entry, system, user, opts = {}) {
    if (entry.type === 'gemini') {
      let r;
      try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(entry.model)}:generateContent`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': entry.key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0, maxOutputTokens: 800 }, ...(opts.search ? { tools: [{ google_search: {} }] } : {}) }) }); }
      catch { throw { status: 0 }; }
      if (!r.ok) throw { status: r.status, body: await r.text().catch(() => '') };
      const j = await r.json(); return ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${entry.key}` };
    if (/openrouter\.ai/.test(entry.base)) headers['X-Title'] = 'Aura';
    let r;
    try { r = await fetch(`${entry.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: entry.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, max_tokens: 400 }) }); }
    catch { throw { status: 0 }; }
    if (!r.ok) throw { status: r.status, body: await r.text().catch(() => '') };
    const j = await r.json(); return C.stripThink((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  }
  const nowText = () => {
    const d = new Date(), off = -d.getTimezoneOffset(), z = `UTC${off >= 0 ? '+' : '-'}${Math.floor(Math.abs(off) / 60)}`;
    return `${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} (${z})`;
  };
  /** Ask up to two available brains to fill in fields from a sentence. Returns the parser's result, { unusable } or { down }. */
  async function extractWith(system, text, parse) {
    let tried = 0, got = false;
    for (const entry of C.available(pool(), S, health)) {
      if (tried >= 2) break;
      try {
        const out = await oneShot(entry, system, text); tried++; got = true;
        setHealth(C.markOk(health, entry.id)); bumpUse(entry.id, 'ok');
        const r = parse(out); if (r) return r;
      } catch (err) {
        if (err.status === undefined) { tried++; continue; }              // an odd reply, not a failing brain: don't punish it
        bumpUse(entry.id, 'fail');
        const cls = C.classifyFailure({ status: err.status, body: err.body, type: entry.type, fails: (health[entry.id] || {}).fails || 0 });
        setHealth(C.markFail(health, entry.id, cls)); updateVia();
      }
    }
    return got ? { unusable: true } : { down: true };
  }
  const extractEvent = (text) => extractWith(
    `Turn the user's message into one calendar event. Now it is ${nowText()}; resolve "today", "tomorrow", weekdays and similar from that date. ` +
    'Answer with ONLY a JSON object, nothing else: {"title":"short title","start":"YYYY-MM-DDTHH:MM","end":"YYYY-MM-DDTHH:MM","location":"place or empty"} in local time, 24-hour. ' +
    'If no end time is given use start plus 1 hour. If the day or the time is missing, answer {"error":"missing"}.', text, C.parseEventJson);
  const extractReminder = (text) => extractWith(
    `Turn the user's message into one reminder. Now it is ${nowText()}; resolve "today", "tomorrow", weekdays and similar from that date. ` +
    'Answer with ONLY a JSON object, nothing else: {"title":"short action such as Call Budi","start":"YYYY-MM-DDTHH:MM","repeat":"none"} in local time, 24-hour. ' +
    'repeat is one of none, daily, weekdays, weekly, monthly ("every day" = daily, "every weekday" = weekdays). If only a time is given with no day, use today if that time is still ahead, otherwise tomorrow. If no time can be worked out, answer {"error":"missing"}.', text, C.parseReminderJson);

  // ───────── the daily brief ─────────
  async function fetchJson(url, ms = 7000) {
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);
    try { const r = await fetch(url, { signal: ac.signal }); if (!r.ok) throw new Error(String(r.status)); return await r.json(); } finally { clearTimeout(tm); }
  }
  async function getWeather(city) {
    const gk = 'geo:' + city.toLowerCase(); let g = store.get(gk, null);
    if (!g) {
      const j = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en`);
      const r = j.results && j.results[0]; if (!r) throw new Error('city not found');
      g = { lat: r.latitude, lon: r.longitude, name: r.name }; store.set(gk, g);
    }
    const j = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=1`);
    return { city: g.name, temp: Math.round(j.current.temperature_2m), min: Math.round(j.daily.temperature_2m_min[0]), max: Math.round(j.daily.temperature_2m_max[0]), rain: j.daily.precipitation_probability_max[0] || 0, code: j.daily.weather_code[0] };
  }
  async function getBitcoin() {
    const j = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
    return { usd: j.bitcoin.usd, chg: j.bitcoin.usd_24h_change };
  }
  /** The S&P 500 has no free browser-friendly feed, so ask Gemini with Google Search (one request a day), and say nothing if it isn't sure. */
  async function getSpx() {
    const e = C.available(pool(), S, health).find((x) => x.type === 'gemini'); if (!e) return null;
    try {
      const out = await oneShot(e, 'Use Google Search to find the S&P 500 index most recent closing level and its percentage change for the last trading day. Answer with ONLY one line in exactly this format: S&P 500 6,123 (+0.4%). If you cannot find it, answer exactly UNAVAILABLE.', 'S&P 500 latest close', { search: true });
      bumpUse(e.id, 'ok'); const m = out.match(/S&P 500\s+[\d,]+(?:\.\d+)?\s*\([+\-−]?\d+(?:\.\d+)?%\)/); return m ? m[0].replace('−', '-') : null;
    } catch { bumpUse(e.id, 'fail'); return null; }
  }
  async function buildBrief() {
    const now = new Date(), r0 = C.parseRange('today', now);
    const calP = (S.calendar && S.gcid && calToken()) ? (async () => {
      const r = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({ timeMin: r0.start.toISOString(), timeMax: r0.end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' }));
      if (!r.ok) throw new Error(String(r.status)); return { items: (await r.json()).items || [] };
    })() : Promise.reject(new Error('no calendar'));
    const [c, w, b, sp] = await Promise.allSettled([calP, S.briefCity ? getWeather(S.briefCity) : Promise.reject(new Error('no city')), S.briefMarkets ? getBitcoin() : Promise.reject(new Error('off')), S.briefMarkets ? getSpx() : Promise.reject(new Error('off'))]);
    return C.formatBrief({ name: S.name, lang: S.briefLang, now, cal: c.value || null, weather: w.value || null, btc: b.value || null, spx: sp.value || null });
  }
  /** The brief on the first open of the day (or when asked from Settings). */
  async function autoBrief(force) {
    if (busy || (!force && !S.brief)) return;
    store.set('briefDay', todayKey()); busy = true; $('btn-mic').disabled = true; dots(); if (!speaking) show('think');
    try { const out = await buildBrief(); await cannedReply({ visible: out.text, gestureName: 'wave', speakText: out.speak }); }
    catch (e) { console.warn('brief', e); busy = false; $('btn-mic').disabled = false; hide(); if (!speaking) show('blink'); }
  }
  /** One heads-up per brain per day when it reaches 80% of its free requests. */
  function usageWarn(entry) {
    if (!entry) return null; const e = C.describe(entry, S), lim = e.limit; if (!lim) return null;
    const u = C.usageOf(usage, entry.id, todayKey()), n = u.ok + u.fail;
    if (n < Math.ceil(lim * 0.8) || n >= lim + 5) return null;
    if (usage.warned && usage.warned[entry.id]) return null;
    usage = { ...usage, warned: { ...(usage.warned || {}), [entry.id]: true } }; store.set('usage', usage);
    return C.usageWarning(e.label, n, lim);
  }

  // ───────── WhatsApp drafts and calendar events ─────────
  let pendingActions = [];
  function actionCard(a, i) {
    if (a.type === 'reminder') {
      const st = new Date(a.start), when = isNaN(st) ? a.start : st.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `<div class="act"><span class="draft">Reminder: ${esc(a.title)} · ${esc(when)}${a.repeat && a.repeat !== 'none' ? ' · ' + esc(C.REPEAT_TEXT.en[a.repeat]) : ''}</span>` +
        `<button class="btn" data-act="rem-add" data-i="${i}">Set reminder</button><button class="btn ghost" data-act="cancel" data-i="${i}">No thanks</button></div>`;
    }
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
    if (kind === 'cal-reconnect') { calConnect(false); return; }
    const a = pendingActions[i];
    if (kind === 'cancel' || !a) { hide(); return; }
    if (kind === 'rem-add') {
      const start = C.localToRfc(a.start), end = C.localToRfc(a.end);
      if (!start || !end) { say('<span class="err">I couldn\'t read that time. Try asking again with a day and time.</span>', 7); return; }
      say('<span class="dots"><span></span><span></span><span></span></span>');
      const tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone;
      const rule = C.REPEAT_RRULE[a.repeat];
      try {
        const r = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary: a.title, start: { dateTime: start, ...(rule && tz ? { timeZone: tz } : {}) }, end: { dateTime: end, ...(rule && tz ? { timeZone: tz } : {}) },
            reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] }, ...(rule ? { recurrence: [rule] } : {}) }),
        });
        if (!r.ok) throw new Error(String(r.status));
        calCache = 0; gesture('nod');
        const first = !store.get('remNoteShown', false); store.set('remNoteShown', true);
        say(esc(`Reminder set: “${a.title}” at ${new Date(a.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${a.repeat && a.repeat !== 'none' ? ', ' + C.REPEAT_TEXT.en[a.repeat] : ''}. ${first ? 'Your Google Calendar will notify you, so check that notifications are on for it in iPhone Settings.' : 'Your calendar will notify you.'}`), first ? 12 : 6);
      } catch (e) { say(`<span class="err">I couldn't set it (${esc(e.message)}). Try reconnecting the calendar in Settings.</span>`, 8); }
      return;
    }
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
  let calCache = 0, calNotice = '', lastCalNotice = 0;
  function calErrorText(status, body) {
    const b = String(body || ''); let msg = ''; try { const j = JSON.parse(b); msg = (j.error && j.error.message) || ''; } catch { /* not JSON */ }
    if (status === 403 && /has not been used|disabled|accessNotConfigured|not enabled/i.test(b)) return 'The Google Calendar API is not switched on for your Google Cloud project. Open console.cloud.google.com > APIs & Services > Library > Google Calendar API > Enable.';
    if (status === 403) return `Google refused calendar access${msg ? ' (' + msg + ')' : ''}. Tap Disconnect, then Connect again and allow calendar access.`;
    if (status === 401) return 'Your Google sign-in expired. Tap Connect Google Calendar again.';
    if (status === 0) return 'I couldn\'t reach Google just now.';
    return `Google said ${status}${msg ? ': ' + msg : ''}.`;
  }
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
      if (!r.ok) throw { status: r.status, body: await r.text().catch(() => '') };
      calCtx = { events: C.formatEvents((await r.json()).items || []), canAdd: S.calAdd }; calCache = Date.now(); calNotice = '';
      return true;
    } catch (e) { console.warn('calendar', e); calCtx = null; calNotice = calErrorText(e.status === undefined ? 0 : e.status, e.body); return false; }
  }
  function handleOAuthReturn() {
    if (!location.hash.includes('state=')) return false;
    const h = new URLSearchParams(location.hash.slice(1));
    window.history.replaceState(null, '', location.pathname);
    if (h.get('state') !== sessionStorage.getItem('aura.oauthState')) return false;
    if (h.get('access_token')) {
      store.set('calToken', { token: h.get('access_token'), exp: Date.now() + (Number(h.get('expires_in')) || 3600) * 1000 - 60e3, scope: calScope() });
      S.calendar = true; saveSettings();
      let pending = null; try { const p = JSON.parse(sessionStorage.getItem('aura.pending') || 'null'); if (p && Date.now() - p.at < 10 * 60e3) pending = p.text; } catch { /* old format */ }
      sessionStorage.removeItem('aura.pending');
      if (pending) setTimeout(() => ask(pending), 600);
      else setTimeout(() => { gesture('celebrate'); say('Your Google Calendar is connected!', 5); }, 800);
    } else if (h.get('error')) {
      if (h.get('error') === 'access_denied') { sessionStorage.removeItem('aura.pending'); S.calendar = false; saveSettings(); }
      setTimeout(() => say(h.get('error') === 'access_denied' ? esc('Okay, I won\'t use your calendar.') : `${esc('I need you to sign in to Google again (it asks about once an hour).')}<div class="act"><button class="btn" data-act="cal-reconnect" data-i="0">Sign in to Google</button></div>`, h.get('error') === 'access_denied' ? 8 : 60), 800);
    }
    return true;
  }
  function calStatus() {
    const el = $('cal-status'), on = S.calendar && S.gcid;
    const t = store.get('calToken', null);
    el.textContent = on ? (calToken() ? `Connected (sign-in valid until ${new Date(t.exp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : 'Connected (sign-in expired, renews when you ask)') : 'Not connected';
    el.classList.toggle('on', !!on);
    $('btn-cal').textContent = on ? 'Disconnect Google Calendar' : 'Connect Google Calendar';
  }
  $('btn-cal').addEventListener('click', () => {
    readSettings();
    if (S.calendar) { S.calendar = false; store.set('calToken', null); calCtx = null; saveSettings(); calStatus(); return; }
    if (!S.gcid) { alert('First paste your Google OAuth Client ID (see the setup guide).'); return; }
    calConnect(false);
  });

  $('btn-cal-test').addEventListener('click', async () => {
    readSettings();
    const out = $('cal-test-out'); out.className = 'test-out';
    if (!S.gcid) { out.className = 'test-out bad'; out.textContent = 'Paste your Google Client ID first.'; return; }
    if (!S.calendar) { out.className = 'test-out bad'; out.textContent = 'Not connected yet. Tap "Connect Google Calendar" above, allow access, and you come back here.'; return; }
    if (!calToken()) { out.className = 'test-out bad'; out.textContent = 'Your Google sign-in has expired (it lasts one hour). Tap Disconnect, then Connect again, or just ask Mira something and she will renew it.'; return; }
    out.textContent = 'Testing…';
    try {
      const now = new Date(), until = new Date(now.getTime() + 7 * 864e5);
      const r = await calFetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams({ timeMin: now.toISOString(), timeMax: until.toISOString(), singleEvents: 'true', maxResults: '50' }));
      const body = await r.text();
      if (!r.ok) { out.className = 'test-out bad'; out.textContent = calErrorText(r.status, body); return; }
      const n = (JSON.parse(body).items || []).length;
      out.className = 'test-out ok';
      out.textContent = `Working: I can read your calendar (${n} event${n === 1 ? '' : 's'} in the next 7 days). Adding events is ${S.calAdd ? 'on (you confirm each one with a button)' : 'switched off'}.`;
    } catch { out.className = 'test-out bad'; out.textContent = calErrorText(0, ''); }
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
    $('s-sharecal').checked = S.shareCalendar; $('s-brief').checked = S.brief; $('s-city').value = S.briefCity; $('s-blang').value = S.briefLang; $('s-bmark').checked = S.briefMarkets; renderBrains();
    $('s-wa').checked = S.whatsapp; $('s-contacts').value = S.contacts; $('s-gcid').value = S.gcid; $('s-caladd').checked = S.calAdd; calStatus();
    renderMemory(); $('settings').hidden = false;
  }
  function readSettings() {
    const oldVoice = S.voice;
    S = { ...S, name: $('s-name').value.trim(), geminiKey: $('s-gemini').value.trim(), groqKey: $('s-groq').value.trim(), model: $('s-model').value,
      speak: $('s-speak').checked, voice: $('s-voice').value, style: $('s-style').value, sounds: $('s-sounds').checked,
      persona: $('s-persona').value.trim() || C.DEFAULT_PERSONA,
      shareCalendar: $('s-sharecal').checked, brief: $('s-brief').checked, briefCity: $('s-city').value.trim(), briefLang: $('s-blang').value, briefMarkets: $('s-bmark').checked, whatsapp: $('s-wa').checked, contacts: $('s-contacts').value.trim(), gcid: $('s-gcid').value.trim(), calAdd: $('s-caladd').checked };
    { const g = (S.pool || []).find((e) => e.id === 'gemini'); if (g) g.model = S.model; }
    saveSettings(); updateVia();
    if (oldVoice !== S.voice) lastSound = 0;
  }
  $('btn-settings').addEventListener('click', () => openSettings(false));
  $('btn-brief-now').addEventListener('click', () => { readSettings(); $('settings').hidden = true; autoBrief(true); });
  $('btn-test-voice').addEventListener('click', async () => {
    readSettings(); unlockAudio(); $('settings').hidden = true;
    say(esc(`Hi${S.name ? ' ' + S.name : ''}! This is my voice.`)); await speak(`Hi${S.name ? ' ' + S.name : ''}! This is my voice.`); hideIn(2);
  });

  // ───────── a little daily rhythm ─────────
  function greet() {
    const now = new Date(), h = now.getHours(), today = now.toDateString();
    const lastSeen = store.get('lastSeen', 0); store.set('lastSeen', Date.now());
    if (!S.geminiKey) return;
    if (S.brief && store.get('briefDay', '') !== today && h >= 4 && !busy && !sessionStorage.getItem('aura.pending')) { setTimeout(() => autoBrief(false), 1200); return; }
    const hi = S.name ? `, ${S.name}` : '';
    if (h >= 5 && h < 11 && store.get('morning', '') !== today) { store.set('morning', today); setTimeout(() => { gesture('drink'); say(esc(`Good morning${hi}! Coffee first?`), 6); }, 900); }
    else if (h >= 23 || h < 4) { setTimeout(() => { gesture('yawn'); say(esc('It\'s late… don\'t stay up too long.'), 6); }, 900); }
    else if (Date.now() - lastSeen > 3 * 3600 * 1000) { setTimeout(() => { gesture('wave'); say(esc(`Welcome back${hi}!`), 5); }, 900); }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') greet(); });

  // ───────── start ─────────
  // Pieces from different versions (page cached, script new, or the other way round): reload once to repair, and say so in Settings
  const buildsMatch = C.BUILD === APP_BUILD && (document.querySelector('script[src^="app.js"]') || {}).src.includes(`v=${APP_BUILD}`);
  $('ver').textContent = buildsMatch ? `version ${APP_BUILD}` : `version mismatch (${C.BUILD}/${APP_BUILD}), reloading`;
  if (!buildsMatch && !sessionStorage.getItem('aura.repaired')) { sessionStorage.setItem('aura.repaired', '1'); location.replace(location.pathname + '?r=' + Date.now()); }
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {            // a new version took over: reload once to use it
      if (hadController && !sessionStorage.getItem('aura.swreload') && !busy) { sessionStorage.setItem('aura.swreload', '1'); location.reload(); }
    });
  }
  imgs[0].addEventListener('load', placeBubble);
  const backFromGoogle = handleOAuthReturn() !== false;
  updateVia();
  if (!S.geminiKey || !S.groqKey) openSettings(true); else if (!backFromGoogle) greet();
  window.Aura = { ask, gesture, say, openSettings, openHistory };   // handy for testing
})();
