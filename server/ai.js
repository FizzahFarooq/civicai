// AI layer. Two modes:
//  * "vision"  - ANTHROPIC_API_KEY is set: Claude looks at the photo (classify + hazard + before/after check)
//  * "manual"  - no key: category comes from the citizen / keywords in the description. Everything else still works.
const { CATEGORIES } = require('./config');

let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* optional */ }

const MODEL = () => process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const hasKey = () => !!(process.env.ANTHROPIC_API_KEY || '').trim();
const mode = () => (hasKey() ? 'vision' : 'manual');

// ---------- images ----------
// Shrinks big phone photos and normalises to JPEG (saves disk + AI cost).
async function normalizeImage(buffer, mime) {
  if (!sharp) return { buffer, mime, ext: mime === 'image/png' ? 'png' : 'jpg' };
  try {
    const out = await sharp(buffer).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }).toBuffer();
    return { buffer: out, mime: 'image/jpeg', ext: 'jpg' };
  } catch (_) {
    return { buffer, mime, ext: mime === 'image/png' ? 'png' : 'jpg' };
  }
}

// 64-bit difference hash: similar photos -> similar hashes (used for duplicate detection)
async function imageHash(buffer) {
  if (!sharp) return null;
  try {
    const px = await sharp(buffer).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] > px[y * 9 + x + 1] ? '1' : '0';
    return BigInt('0b' + bits).toString(16).padStart(16, '0');
  } catch (_) { return null; }
}

function hashSimilarity(a, b) {
  if (!a || !b) return 0;
  let x = BigInt('0x' + a) ^ BigInt('0x' + b), diff = 0;
  while (x) { diff += Number(x & 1n); x >>= 1n; }
  return 1 - diff / 64;
}

// ---------- Claude calls ----------
async function callClaude(content, maxTokens = 400) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY.trim(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(45000)
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI returned no JSON');
  return JSON.parse(m[0]);
}

const imgBlock = (buf, mime) => ({
  type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') }
});

// ---------- keyword fallback (English + Roman Urdu) ----------
const KEYWORDS = [
  ['pothole',      /pothole|gadh?a|khadd?a|khaddy|crater/i],
  ['streetlight',  /street ?light|lamp|bijli|light pole|bulb|\blight\b/i],
  ['water_leak',   /leak|pipe|pani|paani|sewer|sewage|overflow|water/i],
  ['garbage',      /garbage|trash|kachra|kuda|kooda|waste|dump|rubbish/i],
  ['fallen_tree',  /tree|darakht|branch/i],
  ['traffic_sign', /traffic sign|signboard|sign board|signal|\bsign\b/i],
  ['footpath',     /footpath|sidewalk|pavement|encroach|blocked/i],
  ['road_damage',  /road|barrier|divider|crack|broken|damaged/i]
];
function keywordCategory(text = '') {
  for (const [cat, re] of KEYWORDS) if (re.test(text)) return cat;
  return null;
}

// ---------- 1) Identify the problem ----------
async function analyzeImage({ buffer, mime, description, userCategory }) {
  const cats = Object.keys(CATEGORIES).join(', ');
  if (hasKey()) {
    try {
      const out = await callClaude([
        imgBlock(buffer, mime),
        { type: 'text', text:
`You are a city infrastructure inspector. A citizen sent this photo${description ? ` with the note: "${String(description).slice(0, 300)}"` : ''}.
Reply with ONLY a JSON object, no other text:
{"category": one of [${cats}], "confidence": number 0-1, "hazard_level": integer 1-5 (1 = cosmetic, 5 = immediate danger to people/vehicles), "summary": "max 140 characters describing what you see", "is_civic_issue": boolean}` }
      ]);
      const category = CATEGORIES[out.category] ? out.category : 'other';
      return {
        mode: 'vision', category,
        confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0.5)),
        hazard: Math.max(1, Math.min(5, Math.round(Number(out.hazard_level) || 3))),
        summary: String(out.summary || '').slice(0, 200),
        is_civic_issue: out.is_civic_issue !== false
      };
    } catch (err) {
      console.warn('[AI] vision failed, using fallback:', err.message);
    }
  }
  const category = (CATEGORIES[userCategory] && userCategory) || keywordCategory(description) || 'other';
  return {
    mode: 'manual', category, confidence: userCategory ? 1 : 0.4, hazard: 3,
    summary: description ? String(description).slice(0, 140) : CATEGORIES[category].label,
    is_civic_issue: true
  };
}

// ---------- 2) Was it really fixed? ----------
async function compareBeforeAfter({ before, after, category }) {
  if (!hasKey()) {
    return { verdict: 'needs_review', confidence: 0, note: 'AI vision is off, so a staff member must review the before/after photos.' };
  }
  try {
    const label = (CATEGORIES[category] || CATEGORIES.other).label;
    const out = await callClaude([
      { type: 'text', text: 'BEFORE photo (original report):' }, imgBlock(before.buffer, before.mime),
      { type: 'text', text: 'AFTER photo (from citizen or staff):' }, imgBlock(after.buffer, after.mime),
      { type: 'text', text:
`The reported problem was: ${label}. Decide whether the AFTER photo shows the same location with the problem properly fixed.
Reply with ONLY JSON: {"fixed": true|false|null (null if the AFTER photo is unrelated or unclear), "confidence": 0-1, "note": "one short sentence for the citizen"}` }
    ]);
    if (out.fixed === true && out.confidence >= 0.6) return { verdict: 'verified', confidence: out.confidence, note: out.note };
    if (out.fixed === false) return { verdict: 'incomplete', confidence: out.confidence, note: out.note };
    return { verdict: 'needs_review', confidence: out.confidence || 0, note: out.note || 'The AI could not tell. Staff will review.' };
  } catch (err) {
    console.warn('[AI] compare failed:', err.message);
    return { verdict: 'needs_review', confidence: 0, note: 'The AI check failed, so staff will review the photos.' };
  }
}

module.exports = { mode, hasKey, normalizeImage, imageHash, hashSimilarity, analyzeImage, compareBeforeAfter, keywordCategory };
