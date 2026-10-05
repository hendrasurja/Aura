/* Aura for iPhone — pure logic (no DOM), shared with the tests. */
(function (root) {
  'use strict';

  const GIF_MS = {"blink": 3000, "celebrate": 5540, "clap": 3000, "dance": 5540, "dance_b": 5540, "drink": 6740, "heart": 5540, "kiss": 3000, "laugh": 5540, "nod": 4000, "proud": 4940, "sad": 6200, "shake_head": 4400, "shy": 4940, "smile": 4000, "speak": 3000, "surprise": 3540, "tease": 4940, "think": 4940, "wave": 3000, "working": 7940, "yawn": 4000};

  const GESTURES = ['smile', 'laugh', 'surprise', 'nod', 'shake_head', 'think', 'proud', 'shy', 'tease', 'wave',
    'kiss', 'heart', 'celebrate', 'sad', 'dance', 'clap', 'yawn', 'drink'];

  // Little vocal reactions, spoken by Orpheus in her own voice: [text, style]
  const SOUND_LINES = {
    laugh: ['Hehehe!', 'cheerful'], surprise: ['Oh!', 'cheerful'], shy: ['Hehe…', 'whisper'], tease: ['Hehe!', 'friendly'],
    celebrate: ['Yay!', 'cheerful'], clap: ['Yay!', 'cheerful'], kiss: ['Mwah!', 'soft-cheerful'], heart: ['Aww.', 'warm'],
    sad: ['Oh no…', 'warm'], yawn: ['Hmmm… aah.', 'whisper'], wave: ['Hi!', 'cheerful'], nod: ['Mm-hmm.', 'friendly'],
    shake_head: ['Hmph!', 'friendly'], think: ['Hmm…', 'natural'], proud: ['Ta-da!', 'cheerful'], drink: ['Mmm.', 'warm'],
    dance: ['La-la-la!', 'cheerful'], dance_b: ['La-la-la!', 'cheerful'],
  };
  const STYLES = { natural: '', 'soft-cheerful': '[softly cheerful]', cheerful: '[cheerful]', warm: '[warm]', friendly: '[friendly]', whisper: '[whisper]' };
  const VOICES = ['hannah', 'diana', 'autumn', 'austin', 'daniel', 'troy'];
  const MODELS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'];

  const DEFAULT_PERSONA =
    'You are Mira, a warm, playful and sharp companion who lives in the Aura app on the user\'s iPhone (and on their Mac). ' +
    'You talk like a close friend: natural, concise, sometimes a little teasing, never robotic or overly formal. ' +
    'You are also genuinely capable: you search the web for anything current and help with work, research and everyday questions.';

  function buildSystemPrompt({ persona, userName, memory, now, whatsapp, contacts, calendar, search = true }) {
    const parts = [String(persona || DEFAULT_PERSONA).trim()];
    if (userName) parts.push(`The user's name is ${userName}.`);
    if (memory && memory.length) parts.push('Things you remember about the user:\n' + memory.map((m) => `- ${m}`).join('\n'));
    parts.push([
      `Current local date and time: ${now || new Date().toString()}.`,
      'Reply in the language the user writes or speaks in.',
      'Your reply appears in a small speech bubble above your head that shows about the first 150 characters, and it may be read aloud. ' +
        'So lead with a one- or two-sentence answer, then any detail. Avoid tables, code blocks and long lists unless asked.',
      `Begin EVERY reply with exactly one gesture tag in square brackets, chosen to fit your reply, from: ${GESTURES.map((g) => `[${g}]`).join(' ')}. ` +
        'Use [dance] only when asked to dance. The tag is hidden from the user and makes your character move.',
      'When the user tells you something worth remembering long-term (their preferences, people, plans), add [remember: one short fact] at the very end of your reply. It is hidden from the user.',
      search
        ? 'Use Google Search for anything current: news, prices, weather, schedules, recent events.'
        : 'You cannot search the web right now. For anything that depends on current information (news, prices, weather, today\'s events), say plainly that you can\'t check live data at the moment, and answer only from what you know, flagged as possibly out of date.',
    ].join('\n'));
    if (whatsapp) {
      parts.push('WhatsApp: when the user asks you to send, tell or message someone on WhatsApp, write the message for them in the user\'s own voice ' +
        '(first person, as the user, short and natural, in the language they would use with that person) and add [whatsapp: Name | message text] at the very end of your reply. ' +
        'Briefly say in your reply that you drafted it; the user taps a button to open WhatsApp and send it themselves. ' +
        (contacts && contacts.length ? `Saved WhatsApp contacts: ${contacts.join(', ')}.` : 'No contacts are saved; use the name the user gives.'));
    }
    if (calendar && calendar.off) {
      parts.push('Google Calendar is NOT connected to you. If the user asks you to add an event or to look at their schedule, tell them honestly: ' +
        'open Settings > Connections > Google Calendar and tap Connect (it needs the one-time Google setup), and meanwhile you can draft a WhatsApp message. ' +
        'Never say you added or saved anything to a calendar, and never say you are "not integrated with Google Calendar": it is a feature that can be switched on.');
    } else if (calendar) {
      parts.push((calendar.events === null || calendar.events === undefined
        ? 'Google Calendar (the user\'s, local time) is connected, but you cannot see their existing events right now' + (calendar.failed ? ' (reading it failed just now)' : ' (they are not shared with this assistant brain for privacy)') + '. If asked about their schedule, say you cannot see it at the moment; never guess it.\n'
        : `Google Calendar (the user's, local time). Upcoming events, next 7 days:\n${calendar.events || '(none)'}\nAnswer schedule questions from this list.\n`) +
        (calendar.canAdd
          ? 'To add an event when asked, add [calendar_add: Title | YYYY-MM-DDTHH:MM | YYYY-MM-DDTHH:MM | Location] at the very end (start, end, local time; end = start + 1 hour if not given; location may be empty). The user confirms with a button before it is added; say you have prepared it.'
          : 'You can read the calendar but not add events: if asked to add one, say they can switch that on in Settings.'));
    }
    return parts.join('\n\n');
  }

  /** Feed raw SSE text; returns { events, rest } where events are parsed JSON objects. */
  function parseSSE(buffer) {
    const events = [];
    const blocks = buffer.split(/\r?\n\r?\n/);
    const rest = blocks.pop();
    for (const b of blocks) {
      const data = b.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { events.push(JSON.parse(data)); } catch { /* ignore partial */ }
    }
    return { events, rest };
  }

  /** Text and sources from one Gemini stream event (thought parts are skipped). */
  function eventPayload(ev) {
    const c = ev && ev.candidates && ev.candidates[0];
    let text = '';
    if (c && c.content && c.content.parts) for (const p of c.content.parts) if (p.text && !p.thought) text += p.text;
    const sources = [];
    const gm = c && c.groundingMetadata;
    if (gm && gm.groundingChunks) for (const ch of gm.groundingChunks) if (ch.web && ch.web.uri) sources.push({ title: ch.web.title || ch.web.uri, uri: ch.web.uri });
    return { text, sources, finish: c && c.finishReason };
  }

  /**
   * Separate the hidden tags from what the user should see.
   * Returns { gesture, visible, memories, pending } — pending=true while a leading tag may still be arriving.
   */
  function splitTags(raw) {
    let s = stripThink(raw);
    let gesture = null;
    const lead = s.match(/^\s*\[([a-z_]+)\]\s*/i);
    let pending = false;
    if (lead && GESTURES.concat(['dance_b']).includes(lead[1].toLowerCase())) { gesture = lead[1].toLowerCase(); s = s.slice(lead[0].length); }
    else if (/^\s*\[[a-z_]*$/i.test(s)) { pending = true; s = ''; }        // "[lau" — wait for the rest
    const memories = [];
    s = s.replace(/\[remember:\s*([^\]]+)\]/gi, (_, m) => { memories.push(m.trim()); return ''; });
    const actions = [];
    s = s.replace(/\[(whatsapp|calendar_add):\s*([^\]]+)\]/gi, (_, kind, body) => {
      const f = body.split('|').map((x) => x.trim());
      if (kind.toLowerCase() === 'whatsapp' && f.length >= 2) actions.push({ type: 'whatsapp', to: f[0], text: f.slice(1).join(' | ') });
      if (kind.toLowerCase() === 'calendar_add' && f.length >= 2) actions.push({ type: 'calendar', title: f[0], start: f[1], end: f[2] || '', location: f[3] || '' });
      return '';
    });
    const tail = s.match(/\[([^\]]*)$/);                                        // a tag still arriving at the end
    if (tail) {
      const t = tail[1].toLowerCase();
      if (['remember:', 'whatsapp:', 'calendar_add:'].some((k) => k.startsWith(t) || t.startsWith(k))) s = s.slice(0, tail.index);
    }
    s = s.replace(/\[(smile|laugh|surprise|nod|shake_head|think|proud|shy|tease|wave|kiss|heart|celebrate|sad|dance|clap|yawn|drink)\]/gi, '');
    return { actions, gesture, visible: s.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,!?])/g, '$1').replace(/[ \t]+\n/g, '\n').trim(), memories, pending };
  }

  /** Some open models print their reasoning inside <think>…</think>; never show it. */
  function stripThink(t) {
    return String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').replace(/^\s+/, (m) => (/<think>/i.test(t || '') ? '' : m));
  }
  /** Text from one OpenAI-style stream event. */
  function openaiPayload(ev) {
    const d = ev && ev.choices && ev.choices[0] && ev.choices[0].delta;
    return { text: d && typeof d.content === 'string' ? d.content : '', sources: [], finish: ev && ev.choices && ev.choices[0] && ev.choices[0].finish_reason };
  }

  /** Plain text for the bubble and the voice (markdown removed). */
  function plain(t) {
    return String(t || '')
      .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '• ').replace(/[*_~]{1,3}/g, '')
      .replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  /** Split for Orpheus: at most `max` characters per piece, sentence ends first, at most `maxChunks` pieces. */
  function splitForTts(text, max = 190, maxChunks = 3) {
    const clean = plain(text).replace(/•/g, '');
    if (!clean) return [];
    const out = []; let cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (const s of clean.split(/(?<=[.!?…])\s+/)) {
      if (s.length > max) {
        push();
        let rest = s;
        while (rest.length > max) {
          let cut = rest.lastIndexOf(', ', max); if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max); if (cut < 1) cut = max;
          out.push(rest.slice(0, cut + 1).trim()); rest = rest.slice(cut + 1);
        }
        cur = rest;
      } else if ((cur + ' ' + s).trim().length > max) { push(); cur = s; }
      else cur = (cur + ' ' + s).trim();
    }
    push();
    return out.slice(0, maxChunks);
  }

  /** Friendly words for API failures. */
  function friendlyError(status, body) {
    const b = String(body || '');
    if (status === 429) return 'I\'m out of breath: that\'s Gemini\'s free limit. Give me a minute, or switch to Flash-Lite in Settings.';
    if (status === 400 && /API key/i.test(b)) return 'My Gemini key doesn\'t work. Check it in Settings.';
    if (status === 401 || status === 403) return 'My key was refused. Check your keys in Settings.';
    if (status === 404) return 'That Gemini model isn\'t available for your key. Pick another model in Settings.';
    if (status >= 500) return 'Gemini is having trouble right now. Try again in a moment.';
    if (status === 0) return 'I can\'t reach the internet right now.';
    return `Something went wrong (${status}).`;
  }

  /** Read Gemini's 429 details: which limit (per minute / per day / Google Search) and how long to wait. */
  function quotaInfo(body) {
    let j = null; try { j = JSON.parse(body); } catch { /* not JSON */ }
    const details = (j && j.error && j.error.details) || [];
    const ids = [];
    let wait = 0;
    for (const d of details) {
      for (const v of d.violations || []) ids.push(`${v.quotaId || ''} ${v.quotaMetric || ''}`);
      if (d.retryDelay) wait = parseFloat(String(d.retryDelay)) || 0;
    }
    const all = ids.join(' ') + ' ' + String((j && j.error && j.error.message) || body || '');
    const zero = /limit:\s*0\b/i.test(all) || /"quotaValue"\s*:\s*"0"/.test(body || '');
    const message = String((j && j.error && j.error.message) || '').split('\n')[0].slice(0, 160);
    return {
      perDay: /PerDay/i.test(all),
      zero,                                  // this model has no free quota for this key at all
      search: /search|grounding/i.test(all),
      wait: Math.min(60, Math.max(0, Math.round(wait))),
      message,
    };
  }

  /** When the daily free quota resets (midnight US Pacific), as local time text, e.g. "2:00 PM". */
  function quotaResetText(now = new Date()) {
    const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const offset = now.getTime() - la.getTime();
    const next = new Date(la); next.setHours(24, 0, 0, 0);
    return new Date(next.getTime() + offset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /** "Budi: 0812-3456-789" lines -> [{ name, phone }] with an international number (Indonesian 0… -> 62…). */
  function parseContacts(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.+?)[:=,]\s*(\+?[\d\s().-]{6,})$/);
      if (!m) return null;
      let phone = m[2].replace(/\D/g, '');
      if (phone.startsWith('0')) phone = '62' + phone.slice(1);
      return { name: m[1].trim(), phone };
    }).filter(Boolean);
  }
  /** WhatsApp link: straight to the contact if we know the number, otherwise WhatsApp's contact picker. */
  function whatsappLink(to, text, contacts) {
    const c = (contacts || []).find((x) => x.name.toLowerCase() === String(to || '').toLowerCase())
      || (contacts || []).find((x) => x.name.toLowerCase().startsWith(String(to || '').toLowerCase().split(' ')[0]));
    const digits = c ? c.phone : (/^\+?\d[\d\s-]{6,}$/.test(String(to || '').trim()) ? String(to).replace(/\D/g, '') : '');
    return { url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}`, direct: !!digits, name: c ? c.name : to };
  }
  /** "2026-10-06T12:00" (local) -> RFC 3339 with the phone's timezone offset. */
  function localToRfc(s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    if (isNaN(d)) return null;
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    const pad = (n) => String(n).padStart(2, '0');
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  /** Calendar API items -> compact lines for Mira. */
  function formatEvents(items) {
    const fmtDay = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return (items || []).slice(0, 30).map((e) => {
      if (e.start && e.start.date) return `- ${fmtDay(new Date(e.start.date + 'T00:00'))} (all day) ${e.summary || 'Busy'}`;
      const s = new Date(e.start && e.start.dateTime), en = new Date(e.end && e.end.dateTime);
      return `- ${fmtDay(s)} ${fmtTime(s)}–${fmtTime(en)} ${e.summary || 'Busy'}${e.location ? ` (${e.location})` : ''}`;
    }).join('\n');
  }


  // ───────── brains: the pool of AI providers Mira can use ─────────
  const CATALOG = {
    gemini: { label: 'Google Gemini', type: 'gemini', keyUrl: 'https://aistudio.google.com/apikey', note: 'Your main brain. Has Google Search built in.' },
    groq: { label: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', shared: 'groqKey',
      note: 'Free and very fast. Uses the same Groq key as her voice.' },
    openrouter: { label: 'OpenRouter (free models)', type: 'openai', base: 'https://openrouter.ai/api/v1', model: 'openrouter/free', keyUrl: 'https://openrouter.ai/keys',
      note: 'Many free models behind one key, about 50 requests a day. Free models may log prompts.' },
    cerebras: { label: 'Cerebras', type: 'openai', base: 'https://api.cerebras.ai/v1', model: 'gpt-oss-120b', keyUrl: 'https://cloud.cerebras.ai',
      note: 'Free tier, very fast, limited requests per day.' },
    zai: { label: 'Z.AI GLM (Chinese, free model)', type: 'openai', base: 'https://api.z.ai/api/paas/v4', model: 'glm-4.7-flash', keyUrl: 'https://z.ai',
      note: 'Free GLM model, one request at a time. Chinese provider.' },
    mistral: { label: 'Mistral', type: 'openai', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', keyUrl: 'https://console.mistral.ai/api-keys',
      note: 'Free experiment tier (you agree to let them train on prompts).' },
    deepseek: { label: 'DeepSeek (Chinese, very cheap)', type: 'openai', base: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', keyUrl: 'https://platform.deepseek.com/api_keys',
      note: 'Not free but costs cents a month. Chinese provider.' },
    custom: { label: 'Custom (any OpenAI-compatible)', type: 'openai', base: '', model: '', keyUrl: '', note: 'Any provider with an OpenAI-style API: paste its address, model and key.' },
  };
  const LITE = 'gemini-flash-lite-latest';
  function defaultPool(model) {
    return [
      { id: 'gemini', kind: 'gemini', model: model || MODELS[0], enabled: true },
      { id: 'gemini-lite', kind: 'gemini', label: 'Gemini Flash-Lite', model: LITE, enabled: true },
      { id: 'groq', kind: 'groq', enabled: true },
      { id: 'openrouter', kind: 'openrouter', key: '', enabled: true },
      { id: 'cerebras', kind: 'cerebras', key: '', enabled: true },
    ];
  }
  /** Everything about an entry, filling in the catalog defaults. */
  function describe(entry, S) {
    const c = CATALOG[entry.kind] || CATALOG.custom;
    const type = c.type;
    const key = c.shared ? (S[c.shared] || '') : type === 'gemini' ? (S.geminiKey || '') : (entry.key || '');
    return { ...entry, type, label: entry.label || (entry.kind === 'gemini' ? (entry.model === LITE ? 'Gemini Flash-Lite' : 'Google Gemini') : c.label), base: String(entry.base || c.base || '').replace(/\/+$/, ''), model: entry.model || c.model || '', key: String(key).trim(), meta: c };
  }
  /** Entries that can be tried right now, in the user's order. */
  function available(pool, S, health, now = Date.now()) {
    const seen = new Set();
    return (pool || []).map((e) => describe(e, S)).filter((e) => {
      if (!e.enabled || !e.key || (e.type === 'openai' && (!e.base || !e.model))) return false;
      const h = (health || {})[e.id]; if (h && h.until > now) return false;
      const dup = `${e.type}|${e.base}|${e.model}|${e.key}`; if (seen.has(dup)) return false; seen.add(dup);
      return true;
    });
  }
  const LADDER = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3];
  /** When Gemini's daily free quota refreshes (midnight US Pacific), as a timestamp. */
  function quotaResetAt(now = new Date()) {
    const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const next = new Date(la); next.setHours(24, 0, 0, 0);
    return now.getTime() + (next.getTime() - la.getTime());
  }
  /** Read a failure: how long should this provider rest, and what should we tell the user? */
  function classifyFailure({ status, body, type, fails = 0, now = Date.now() }) {
    const b = String(body || '');
    const ladder = LADDER[Math.min(fails, LADDER.length - 1)];
    if (status === 0) return { k: 'network', ms: 2 * 60e3, why: 'can\'t be reached from here' };
    if (status === 401 || status === 403 || (status === 400 && /API key/i.test(b))) return { k: 'auth', ms: 3600e3, why: 'key refused', fix: true };
    if (status === 404) return { k: 'model', ms: 3600e3, why: 'model not found', fix: true };
    if (status === 402) return { k: 'payment', ms: 3600e3, why: 'out of credit' };
    if (status === 429) {
      if (type === 'gemini') {
        const q = quotaInfo(b);
        if (q.perDay || q.zero) return { k: 'daily', ms: Math.max(60e3, quotaResetAt(new Date(now)) - now), why: q.zero ? 'no free quota for this model' : 'daily limit reached' };
        const explicit = q.wait ? q.wait * 1000 + 2000 : 0;
        return { k: 'rate', ms: explicit ? Math.max(explicit, fails ? ladder : 0) : ladder, why: 'too many requests' };
      }
      const hint = b.match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i);
      const waitMs = hint ? ((Number(hint[1] || 0) * 60) + Number(hint[2])) * 1000 : 0;
      if (/per day|daily|\bRPD\b|TPD/i.test(b)) return { k: 'daily', ms: Math.max(waitMs, 3600e3), why: 'daily limit reached' };
      const explicit = waitMs ? waitMs + 2000 : 0;
      return { k: 'rate', ms: explicit ? Math.max(explicit, fails ? ladder : 0) : ladder, why: 'too many requests' };
    }
    if (status >= 500) return { k: 'server', ms: 2 * 60e3, why: 'having trouble' };
    return { k: 'bad', ms: 5 * 60e3, why: `error ${status}` };
  }
  function markFail(health, id, cls, now = Date.now()) {
    const h = { ...(health || {}) }; const prev = h[id] || {};
    h[id] = { until: now + cls.ms, fails: (prev.fails || 0) + 1, k: cls.k, why: cls.why, fix: !!cls.fix };
    return h;
  }
  function markOk(health, id) { const h = { ...(health || {}) }; delete h[id]; return h; }
  /** "in 40 s", "in 12 min", or a clock time like "2:00 PM" */
  function backText(ts, now = Date.now()) {
    const d = ts - now;
    if (d <= 1500) return 'now';
    if (d < 90e3) return `in ${Math.ceil(d / 1000)} s`;
    if (d < 3600e3) return `in ${Math.round(d / 60e3)} min`;
    return `at ${new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  /** One line for each entry in Settings. */
  function statusOf(entry, S, health, now = Date.now()) {
    const e = describe(entry, S);
    if (!e.enabled) return { state: 'off', text: 'Switched off' };
    if (!e.key) return { state: 'nokey', text: 'Add a key to use it' };
    if (e.type === 'openai' && (!e.base || !e.model)) return { state: 'nokey', text: 'Add its address and model' };
    const h = (health || {})[e.id];
    if (h && h.until > now) return { state: h.fix ? 'fix' : 'resting', text: h.fix ? `Needs attention: ${h.why}` : `Resting (${h.why}), back ${backText(h.until, now)}` };
    return { state: 'ready', text: 'Ready' };
  }
  /** "Gemini back at 2:00 PM · Groq in 1 min" for when every brain is resting. */
  function restingSummary(pool, S, health, now = Date.now()) {
    return (pool || []).map((e) => describe(e, S)).filter((e) => e.enabled && e.key && (health || {})[e.id] && health[e.id].until > now)
      .map((e) => `${e.label} ${backText(health[e.id].until, now)}`).join(' · ');
  }
  function soonestReturn(pool, S, health, now = Date.now()) {
    const t = (pool || []).map((e) => describe(e, S)).filter((e) => e.enabled && e.key && (health || {})[e.id] && !health[e.id].fix).map((e) => health[e.id].until);
    return t.length ? Math.min(...t) : 0;
  }

  const BUILD = '13';
  // ───────── schedule questions answered straight from the calendar (no AI involved) ─────────
  const guessLang = (t) => (/\b(besok|lusa|hari ini|jadwal|kalender|agenda|saya|aku|gue|apa|ada|minggu|pekan|senin|selasa|rabu|kamis|jumat|sabtu|rapat|acara|kosong|sibuk|bisa)\b/i.test(t) ? 'id' : 'en');
  /** "what's on my calendar tomorrow", "am I free Friday afternoon", "apa jadwal saya besok"… (not adding events) */
  function scheduleIntent(text) {
    const t = String(text || '').toLowerCase();
    if (calendarIntent(t)) return false;
    const thing = '(?:calendar|agenda|(?:my|our|the|your)\\s+schedule|meetings?|appointments?|events?|plans|kalender|jadwal|acara|rapat|janji)';
    const ask = "(?:what(?:['’]s|\\s+is|\\s+are)?|show|list|check|tell me|read|any|apa|ada|cek|lihat|tunjukkan|kasih tahu|bacakan)";
    const strong = '(?:calendar|agenda|kalender|jadwal|acara|rapat|janji|(?:my|our|your|the)\\s+schedule|(?:my|our|your)\\s+(?:meetings?|appointments?|events?|plans))';
    return new RegExp(`\\b${ask}\\b[\\s\\S]{0,40}\\b${strong}\\b`).test(t)
      || /\bany\s+(?:meetings?|appointments?|events?|plans)\b(?![\s\S]{0,15}\b(?:of|for|by|from|at)\b)[\s\S]{0,25}\b(?:today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(t)
      || /\bwhat\s+(?:do i have|have i got|am i doing)\b/.test(t)
      || /\bwhat(?:['’]s|\s+is)\s+(?:coming up|on)\b[\s\S]{0,25}\b(?:today|tomorrow|tonight|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)/.test(t)
      || /\b(?:besok|hari ini|lusa|minggu ini|minggu depan|pekan ini|pekan depan)\s+ada\s+apa\b/.test(t)
      || /\b(?:am i|are we)\s+(?:free|busy|available)\b/.test(t)
      || new RegExp(`\\bdo i have\\b[\\s\\S]{0,40}\\b(?:anything|something|${thing}|free time)\\b`).test(t)
      || new RegExp(`\\b(?:is there|have i got)\\b[\\s\\S]{0,30}\\b(?:anything|${thing})\\b`).test(t)
      || new RegExp(`\\b(?:calendar|agenda|(?:my|the|our)\\s+schedule|kalender|jadwal)\\b[\\s\\S]{0,25}\\b(?:today|tomorrow|tonight|this week|next week|hari ini|besok|lusa|minggu ini|minggu depan|pekan ini|pekan depan|monday|tuesday|wednesday|thursday|friday|saturday|sunday|senin|selasa|rabu|kamis|jumat|sabtu)\\b`).test(t)
      || /\b(?:besok|hari ini|lusa)\s+(?:ada|saya ada|aku ada)\s+(?:apa|acara|rapat|jadwal)\b/.test(t)
      || /\b(?:saya|aku|gue)\s+(?:ada|punya)\s+(?:acara|rapat|meeting|agenda|jadwal|janji)\b/.test(t)
      || /\b(?:kosong|sibuk)\s+(?:nggak|gak|tidak|ngga)?\b/.test(t) && /\b(?:besok|hari ini|lusa|minggu|senin|selasa|rabu|kamis|jumat|sabtu)\b/.test(t);
  }
  const isFreeQuestion = (t) => /\b(am i|are we)\s+(free|busy|available)\b|\bfree time\b|\b(kosong|sibuk|luang)\b|\bavailable\b/i.test(String(t || ''));
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, mei: 4, jun: 5, jul: 6, aug: 7, agu: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, des: 11 };
  const WEEKDAYS = [['sunday|sun|hari minggu', 0], ['monday|mon|senin', 1], ['tuesday|tues|tue|selasa', 2], ['wednesday|wed|rabu', 3], ['thursday|thurs|thur|thu|kamis', 4], ['friday|fri|jumat|jum\'at', 5], ['saturday|sat|sabtu', 6]];
  const sod = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  /** Which days is the person asking about? -> { start, end (exclusive), key, part, date } */
  function parseRange(text, now = new Date()) {
    const t = String(text || '').toLowerCase(); const today = sod(now);
    let part = null;
    if (/\b(morning|pagi)\b/.test(t)) part = 'morning'; else if (/\b(afternoon|siang|sore)\b/.test(t)) part = 'afternoon'; else if (/\b(evening|tonight|night|malam)\b/.test(t)) part = 'evening';
    const mk = (start, days, key, extra = {}) => ({ start, end: addDays(start, days), key, part, ...extra });
    const monday = addDays(today, (8 - today.getDay()) % 7 || 7);
    if (/\b(day after tomorrow|lusa)\b/.test(t)) return mk(addDays(today, 2), 1, 'lusa');
    if (/\b(tomorrow|besok)\b/.test(t)) return mk(addDays(today, 1), 1, 'tomorrow');
    if (/\b(next week|minggu depan|pekan depan)\b/.test(t)) return mk(monday, 7, 'nextweek');
    if (/\b(this week|minggu ini|pekan ini|week)\b/.test(t)) return { start: today, end: monday, key: 'week', part };
    if (/\b(today|hari ini|tonight|malam ini|sekarang|now)\b/.test(t)) return mk(today, 1, 'today');
    for (const [names, n] of WEEKDAYS) {
      if (new RegExp(`\\b(?:${names})\\b`).test(t)) { const diff = (n - today.getDay() + 7) % 7; return mk(addDays(today, diff), 1, 'weekday', { date: addDays(today, diff) }); }
    }
    const mon = Object.keys(MONTHS).join('|');
    const m1 = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(${mon})[a-z]*\\b`)) || null;
    const m2 = t.match(new RegExp(`\\b(${mon})[a-z]*\\.?\\s*(\\d{1,2})\\b`)) || null;
    if (m1 || m2) {
      const day = Number(m1 ? m1[1] : m2[2]), month = MONTHS[(m1 ? m1[2] : m2[1])];
      let d = new Date(today.getFullYear(), month, day); if (d < today) d = new Date(today.getFullYear() + 1, month, day);
      return mk(d, 1, 'date', { date: d });
    }
    return { start: today, end: addDays(today, 7), key: 'next7', part };
  }
  const PART_HOURS = { morning: [6, 12], afternoon: [12, 18], evening: [18, 23], null: [8, 20] };
  const LBL = {
    en: { today: 'today', tomorrow: 'tomorrow', lusa: 'the day after tomorrow', week: 'this week', nextweek: 'next week', next7: 'in the next 7 days', parts: { morning: 'morning', afternoon: 'afternoon', evening: 'evening' } },
    id: { today: 'hari ini', tomorrow: 'besok', lusa: 'lusa', week: 'minggu ini', nextweek: 'minggu depan', next7: 'dalam 7 hari ke depan', parts: { morning: 'pagi', afternoon: 'siang-sore', evening: 'malam' } },
  };
  const LOC = { en: 'en-GB', id: 'id-ID' };
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  function rangeLabel(range, lang) {
    const L = LBL[lang]; let base;
    if (range.key === 'weekday' || range.key === 'date') {
      const d = range.date.toLocaleDateString(LOC[lang], { weekday: range.key === 'weekday' ? 'long' : undefined, day: 'numeric', month: 'short' });
      base = lang === 'id' ? `pada ${d}` : `on ${d}`;
    } else base = L[range.key];
    return range.part && range.end - range.start <= 864e5 + 3600e3 ? `${base} ${L.parts[range.part]}` : base;
  }
  /** Calendar API items -> { title, allDay, start, end, location } */
  function normalizeEvents(items) {
    return (items || []).filter((e) => e.status !== 'cancelled').map((e) => {
      const allDay = !!(e.start && e.start.date);
      const start = allDay ? new Date(e.start.date + 'T00:00') : new Date(e.start.dateTime);
      const end = allDay ? new Date((e.end && e.end.date ? e.end.date : e.start.date) + 'T00:00') : new Date(e.end && e.end.dateTime ? e.end.dateTime : e.start.dateTime);
      return { title: e.summary || (lang0 === 'id' ? 'Sibuk' : 'Busy'), allDay, start, end, location: e.location || '' };
    }).filter((e) => !isNaN(e.start)).sort((a, b) => a.start - b.start);
  }
  let lang0 = 'en';
  /** Free stretches of at least `min` minutes inside [ws, we) given busy events. */
  function freeGaps(events, ws, we, min = 30) {
    const busy = events.filter((e) => !e.allDay && e.end > ws && e.start < we).map((e) => [Math.max(e.start, ws), Math.min(e.end, we)]).sort((a, b) => a[0] - b[0]);
    const gaps = []; let cur = ws.getTime();
    for (const [a, b] of busy) { if (a - cur >= min * 60e3) gaps.push([new Date(cur), new Date(a)]); cur = Math.max(cur, b); }
    if (we - cur >= min * 60e3) gaps.push([new Date(cur), new Date(we)]);
    return gaps;
  }
  /** The answer text (and a short version to speak) for a schedule question. */
  function formatSchedule(items, range, { lang = 'en', free = false } = {}) {
    lang0 = lang; const evs = normalizeEvents(items); const label = rangeLabel(range, lang); const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
    const [h0, h1] = PART_HOURS[range.part];
    const days = []; for (let d = new Date(range.start); d < range.end && days.length < 14; d = addDays(d, 1)) days.push(new Date(d));
    const inDay = (d) => evs.filter((e) => e.end > d && e.start < addDays(d, 1) && (e.allDay || e.end > d) && (!range.part || e.allDay || (e.end > new Date(d.getFullYear(), d.getMonth(), d.getDate(), h0) && e.start < new Date(d.getFullYear(), d.getMonth(), d.getDate(), h1))));
    const line = (e) => `• ${e.allDay ? (lang === 'id' ? '(seharian)' : '(all day)') : `${hhmm(e.start)}–${hhmm(e.end)}`} ${e.title}${e.location ? ` (${e.location})` : ''}`;
    if (free) {
      const out = []; const shown = days.slice(0, 3);
      for (const d of shown) {
        const ws = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h0), we = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h1);
        const gaps = freeGaps(evs, d.getTime() === sod(new Date()).getTime() && new Date() > ws ? (new Date() < we ? new Date() : we) : ws, we);
        const dn = shown.length > 1 ? `${d.toLocaleDateString(LOC[lang], { weekday: 'short', day: 'numeric', month: 'short' })}: ` : '';
        const whole = gaps.length === 1 && gaps[0][0] <= ws && gaps[0][1] >= we;
        out.push(`${dn}${!gaps.length ? (lang === 'id' ? 'tidak ada waktu kosong' : 'no free time') : whole ? (lang === 'id' ? 'kosong sepanjang waktu itu' : 'free the whole time') : (lang === 'id' ? 'kosong ' : 'free ') + gaps.map(([a, b]) => `${hhmm(a)}–${hhmm(b)}`).join(', ')}`);
      }
      const head = lang === 'id' ? `Soal waktu luang ${label}:` : `About your free time ${label}:`;
      const body = out.map((x) => `• ${x}`).join('\n');
      const sched = evs.filter((e) => days.some((d) => inDay(d).includes(e))).slice(0, 12);
      return { text: `${head}\n${body}${sched.length ? `\n\n${lang === 'id' ? 'Yang sudah ada:' : 'Already booked:'}\n${sched.map(line).join('\n')}` : ''}`, speak: `${head} ${out[0]}` };
    }
    const groups = days.map((d) => ({ d, list: inDay(d) })).filter((g) => g.list.length);
    const all = groups.reduce((n, g) => n + g.list.length, 0);
    if (!all) { const t = lang === 'id' ? `Tidak ada acara di kalendermu ${label}. Kosong!` : `You have nothing on your calendar ${label}. All clear!`; return { text: t, speak: t }; }
    const first = groups[0].list.find((e) => !e.allDay) || groups[0].list[0];
    const sentence = lang === 'id'
      ? `${cap(label)} kamu punya ${all} acara, pertama ${first.title}${first.allDay ? ' (seharian)' : ' jam ' + hhmm(first.start)}.`
      : `${cap(label)} you have ${all} thing${all > 1 ? 's' : ''}, starting with ${first.title}${first.allDay ? ' (all day)' : ' at ' + hhmm(first.start)}.`;
    const body = groups.length === 1 && days.length === 1 ? groups[0].list.slice(0, 25).map(line).join('\n')
      : groups.slice(0, 10).map((g) => `${g.d.toLocaleDateString(LOC[lang], { weekday: 'short', day: 'numeric', month: 'short' })}\n${g.list.slice(0, 8).map(line).join('\n')}`).join('\n\n');
    return { text: `${sentence}\n\n${body}`, speak: sentence };
  }

  /** Does this message ask to put something in the calendar? (English and Indonesian) */
  function calendarIntent(text) {
    const t = String(text || '');
    const add = '(?:add|put|schedule|book|create|save|enter|log|block|set up|insert|tambah(?:kan)?|masukkan|masukin|catat|jadwalkan|buat(?:kan)?|simpan)';
    const cal = '(?:calendar|agenda|schedule|event|appointment|meeting|call|lunch|dinner|interview|reminder|kalender|jadwal|acara|rapat)';
    return new RegExp(`\\b${add}\\b[\\s\\S]{0,80}\\b${cal}\\b|\\b${cal}\\b[\\s\\S]{0,40}\\b${add}\\b`, 'i').test(t) && !/\b(what|which|apa|show|list|check|cek|lihat)\b[\s\S]{0,30}\b(on|in|di|ada)\b/i.test(t.slice(0, 40));
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  /** Read the model's JSON answer for "extract the event". Returns { ev } | { missing: true } | null (unusable). */
  function parseEventJson(out) {
    const m = String(out || '').replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j; try { j = JSON.parse(m[0]); } catch { return null; }
    if (j.error) return { missing: true };
    const ok = (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s || ''));
    if (!j.title || !ok(j.start)) return j.title || j.start ? { missing: true } : null;
    const st = new Date(String(j.start).slice(0, 16));
    if (isNaN(st)) return null;
    let en = ok(j.end) ? new Date(String(j.end).slice(0, 16)) : null;
    if (!en || isNaN(en) || en <= st) en = new Date(st.getTime() + 3600e3);
    return { ev: { type: 'calendar', title: String(j.title).trim().slice(0, 120), start: fmtLocal(st), end: fmtLocal(en), location: String(j.location || '').trim().slice(0, 120) } };
  }
  const api = { BUILD, guessLang, scheduleIntent, isFreeQuestion, parseRange, rangeLabel, normalizeEvents, freeGaps, formatSchedule, calendarIntent, parseEventJson, CATALOG, LITE, defaultPool, describe, available, quotaResetAt, classifyFailure, markFail, markOk, backText, statusOf, restingSummary, soonestReturn,
    stripThink, openaiPayload, parseContacts, whatsappLink, localToRfc, formatEvents, quotaInfo, quotaResetText, GIF_MS, GESTURES, SOUND_LINES, STYLES, VOICES, MODELS, DEFAULT_PERSONA, buildSystemPrompt, parseSSE, eventPayload, splitTags, plain, splitForTts, friendlyError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AuraCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
