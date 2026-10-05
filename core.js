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

  function buildSystemPrompt({ persona, userName, memory, now }) {
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
      'Use Google Search for anything current: news, prices, weather, schedules, recent events.',
    ].join('\n'));
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
    let s = String(raw || '');
    let gesture = null;
    const lead = s.match(/^\s*\[([a-z_]+)\]\s*/i);
    let pending = false;
    if (lead && GESTURES.concat(['dance_b']).includes(lead[1].toLowerCase())) { gesture = lead[1].toLowerCase(); s = s.slice(lead[0].length); }
    else if (/^\s*\[[a-z_]*$/i.test(s)) { pending = true; s = ''; }        // "[lau" — wait for the rest
    const memories = [];
    s = s.replace(/\[remember:\s*([^\]]+)\]/gi, (_, m) => { memories.push(m.trim()); return ''; });
    const tail = s.match(/\[([^\]]*)$/);                                        // a tag still arriving at the end
    if (tail) { const t = tail[1].toLowerCase(); if ('remember:'.startsWith(t) || t.startsWith('remember:')) s = s.slice(0, tail.index); }
    s = s.replace(/\[(smile|laugh|surprise|nod|shake_head|think|proud|shy|tease|wave|kiss|heart|celebrate|sad|dance|clap|yawn|drink)\]/gi, '');
    return { gesture, visible: s.replace(/[ \t]{2,}/g, ' ').replace(/ ([.,!?])/g, '$1').replace(/[ \t]+\n/g, '\n').trim(), memories, pending };
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

  const api = { GIF_MS, GESTURES, SOUND_LINES, STYLES, VOICES, MODELS, DEFAULT_PERSONA, buildSystemPrompt, parseSSE, eventPayload, splitTags, plain, splitForTts, friendlyError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AuraCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
