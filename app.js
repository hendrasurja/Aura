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
  const DEFAULTS = { name: '', geminiKey: '', groqKey: '', model: C.MODELS[0], speak: true, voice: 'hannah', style: 'soft-cheerful', sounds: true, persona: C.DEFAULT_PERSONA };
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
  let typed = '', target = '', done = false, typer = null, hideTimer = null;
  function placeBubble() {
    const img = imgs[front]; const r = img.getBoundingClientRect(); const st = $('stage').getBoundingClientRect();
    if (!r.height) return;
    const head = r.top + r.height * 0.165 - st.top;            // her head is ~16.5% down the full-body image
    bubble.style.bottom = `${st.height - head + 12}px`;
    bubble.style.maxHeight = `${Math.max(70, head - 16)}px`;           // never taller than the space above her head
  }
  window.addEventListener('resize', placeBubble);
  const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function say(html, seconds) { clearInterval(typer); typer = null; bubble.innerHTML = html; bubble.classList.add('show'); placeBubble(); if (seconds) hideIn(seconds); else clearTimeout(hideTimer); }
  function hide() { bubble.classList.remove('show'); clearInterval(typer); typer = null; }
  function hideIn(sec) { clearTimeout(hideTimer); hideTimer = setTimeout(hide, sec * 1000); }
  const dots = () => say('<span class="dots"><span></span><span></span><span></span></span>');
  function render() {
    let limit = MAX;
    for (let guard = 0; guard < 20; guard++) {                 // shorten until it fits the space above her head
      let t = typed, more = false;
      if (t.length > limit) { t = t.slice(0, limit).replace(/\s+\S*$/, ''); more = true; }
      if (done && target.length > limit) more = true;
      bubble.innerHTML = esc(t) + (more ? `${/[.!?…]$/.test(t) ? '' : '…'} <span class="more">more</span>` : '');
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
  bubble.addEventListener('click', (e) => { if (e.target.classList.contains('more')) openHistory(); else hide(); });

  // ───────── conversation with Gemini ─────────
  let busy = false;
  async function geminiStream(useSearch, onChunk) {
    const contents = history.slice(-16).map((m) => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: m.text }] }));
    const body = {
      systemInstruction: { parts: [{ text: C.buildSystemPrompt({ persona: S.persona, userName: S.name, memory, now: new Date().toString() }) }] },
      contents,
      generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
    };
    if (useSearch) body.tools = [{ google_search: {} }];
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.model)}:streamGenerateContent?alt=sse`, {
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
    busy = true; $('btn-mic').disabled = true;
    history.push({ role: 'user', text }); store.set('history', history);
    dots(); if (!speaking) { clearTimeout(gestureTimer); show('think'); }
    let raw = '', sources = [], gestured = false;
    typed = ''; target = ''; done = false;
    const onChunk = (p) => {
      raw += p.text; for (const s of p.sources) if (!sources.some((x) => x.uri === s.uri)) sources.push(s);
      const t = C.splitTags(raw);
      if (t.gesture && !gestured) { gestured = true; gesture(t.gesture); }
      if (t.visible) stream(t.visible, false);
    };
    let attempt = 0, useSearch = true;
    for (;;) {
      try { await geminiStream(useSearch, onChunk); break; }
      catch (err) {
        if (raw) break;                                       // partial answer: keep what we have
        if (err.status === 400 && useSearch && !/API key/i.test(err.body || '')) { useSearch = false; continue; }  // model without search
        if (err.status === 429 && attempt === 0) {
          attempt++;
          for (let s = 20; s > 0; s--) { say(`I'm out of breath (Gemini's free limit). Trying again in ${s}s…`); await new Promise((r) => setTimeout(r, 1000)); }
          dots(); continue;
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
    history.push({ role: 'model', text: t.visible, sources }); history = history.slice(-80); store.set('history', history);
    stream(t.visible, true);
    busy = false; $('btn-mic').disabled = false;
    if (!t.visible) { hide(); return; }
    const spoke = S.speak && (await speak(t.visible));
    if (!spoke) hideIn(readTime(t.visible)); else hideIn(2.5);
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
    renderMemory(); $('settings').hidden = false;
  }
  function readSettings() {
    const oldVoice = S.voice;
    S = { ...S, name: $('s-name').value.trim(), geminiKey: $('s-gemini').value.trim(), groqKey: $('s-groq').value.trim(), model: $('s-model').value,
      speak: $('s-speak').checked, voice: $('s-voice').value, style: $('s-style').value, sounds: $('s-sounds').checked,
      persona: $('s-persona').value.trim() || C.DEFAULT_PERSONA };
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
  if (!S.geminiKey || !S.groqKey) openSettings(true); else greet();
  window.Aura = { ask, gesture, say, openSettings, openHistory };   // handy for testing
})();
