/**
 * Gemini.gs — optional AI "mind" for the Telda Support bot (free Google Gemini tier).
 *
 * Grounded generation: the caller (Code.gs `ask`) first runs the keyword search, then
 * passes ONLY the top-matching KB topics here. Gemini answers strictly from those, so it
 * understands messy phrasing and drafts the reply without hallucinating procedures.
 *
 * Requires Script Property: GEMINI_KEY (free key from https://aistudio.google.com).
 * Returns: { covered, internal, reply_en, reply_ar, sources[] }.
 */

var GEMINI_MODEL = 'gemini-2.0-flash'; // fast + generous free tier

function geminiConfigured_() {
  return !!PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
}

function geminiAnswer_(query, matches) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_KEY');
  if (!key) throw new Error('GEMINI_KEY is not set.');

  var kbText = matches.map(function (m, i) {
    return '### [' + (i + 1) + '] ' + m.title + '  (Category: ' + m.category + ')\n' + m.content;
  }).join('\n\n');

  var instructions = [
    'You are the Telda customer-support assistant, helping support agents in Egypt.',
    'Use ONLY the KNOWLEDGE BASE excerpts provided below. Never invent SLAs, links, fees, or steps.',
    'Reply strictly as a single JSON object with these exact fields:',
    '- "covered": boolean — true only if the excerpts genuinely cover the agent\'s case.',
    '- "internal": string — concise guidance FOR THE AGENT: what to do, the SLA, any Jira/Slack links, the contact tree, and info to collect. Use short dashed lines.',
    '- "reply_en": string — a professional, ready-to-send reply to the customer, in English.',
    '- "reply_ar": string — the SAME reply in professional Egyptian Arabic (لهجة مصرية مهنية ومحترمة), natural and clear (not stiff MSA).',
    '- "sources": array of strings — the topic titles you used.',
    'If "covered" is false: put a one-line note in "internal" that the case is not in the knowledge base, and set "reply_en" and "reply_ar" to empty strings.',
    'If information is missing to resolve the case, the customer replies should politely ask for exactly what is needed.',
    'Do not include any text outside the JSON object.'
  ].join('\n');

  var prompt = instructions +
    '\n\n=== KNOWLEDGE BASE ===\n' + kbText +
    '\n\n=== AGENT\'S CASE ===\n' + query;

  var body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(body)
  });

  var code = res.getResponseCode();
  if (code === 429) throw new Error('Gemini free-tier rate limit reached — try again in a minute.');
  if (code < 200 || code >= 300) {
    throw new Error('Gemini API ' + code + ': ' + res.getContentText().slice(0, 200));
  }

  var data = JSON.parse(res.getContentText());
  var text;
  try { text = data.candidates[0].content.parts[0].text; }
  catch (e) { throw new Error('Unexpected Gemini response.'); }

  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    var m = text.match(/\{[\s\S]*\}/); // salvage a JSON object if wrapped in prose
    obj = m ? JSON.parse(m[0]) : { covered: false, internal: text, reply_en: '', reply_ar: '', sources: [] };
  }

  return {
    covered: !!obj.covered,
    internal: obj.internal || '',
    reply_en: obj.reply_en || '',
    reply_ar: obj.reply_ar || '',
    sources: obj.sources || []
  };
}
