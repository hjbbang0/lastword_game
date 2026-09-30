// 끝말 헌터 AI 심판 — 브라우저는 단어만 보내고, 프롬프트와 API 키는 서버에만 있습니다.
// UPSTAGE_API_KEY가 있으면 Upstage Solar를, 없으면 ANTHROPIC_API_KEY로 Claude를 사용합니다.
// AI Initiative(기관 무료)는 Solar Pro 4만 무료 → 다른 모델로 실수로 과금되지 않게 잠금
// 유료 모델을 일부러 쓰려면 UPSTAGE_ALLOW_PAID=1 을 함께 설정
const FREE_MODELS = /^solar-pro4(-\d+)?$/;
const WANTED = process.env.UPSTAGE_MODEL || "solar-pro4";
const UPSTAGE_MODEL = FREE_MODELS.test(WANTED) || process.env.UPSTAGE_ALLOW_PAID === "1" ? WANTED : "solar-pro4";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const HANGUL = /^[가-힣]{2,14}$/;

const RULE_TEXT = `[유효한 단어]
- 표준국어대사전·우리말샘에 있는 한국어 명사(외래어 명사 포함).
- 또는 최근(대략 2015년 이후) 한국에서 널리 쓰이는 신조어·유행어·최신 일반명사 (예: 숏폼, 챌린지, 밈, 먹방, 탕후루, 챗봇).
- 무효: 사람 이름·지명·상호·상표 같은 고유명사, 문장이나 구, 동사·형용사 활용형, 존재하지 않는 말, 비속어, 한 글자.`;

const GUIDE = {
  easy: "쉬움: 초등학생도 아는 흔한 단어를 골라. 신조어는 쓰지 마.",
  normal: "보통: 흔한 단어 위주로, 가끔 최신 신조어나 조금 어려운 단어를 섞어.",
  hell: "지옥: 반드시 한방단어를 노려라. 즉 끝 글자로 시작하는 명사가 거의 없어서 상대가 잇기 어려운 단어(예: ~늄, ~릇, ~슭, ~녘, ~쁨, ~듐, ~튬, ~즘 으로 끝나는 말)를 최우선으로 고르고, 그런 단어가 없을 때만 끝 글자가 까다로운 희귀어·최신어를 써.",
};
const TAGS = `각 단어의 rare는 초등 고학년이 뜻을 모를 법한 단어면 true, trend는 2015년 이후 생긴 신조어·최신어면 true. meaning은 rare나 trend가 true일 때만 35자 이내의 쉬운 설명, 아니면 빈 문자열.`;

function dueum(ch) {
  const c = ch.charCodeAt(0) - 0xac00; if (c < 0 || c > 11171) return null;
  const cho = Math.floor(c / 588), jung = Math.floor((c % 588) / 28), jong = c % 28; let nc = cho;
  if (cho === 5) nc = [2, 6, 7, 12, 17, 20].includes(jung) ? 11 : 2;
  else if (cho === 2 && [6, 12, 17, 20].includes(jung)) nc = 11;
  return nc === cho ? null : String.fromCharCode(0xac00 + nc * 588 + jung * 28 + jong);
}

function buildPrompt(kind, word, used, mode, allowed) {
  const usedTxt = used.join(", ") || "없음";
  if (kind === "turn") {
    const last = word.slice(-1), d = dueum(last);
    return `너는 한국어 끝말잇기 게임의 심판이자 상대 플레이어다.

${RULE_TEXT}

[이번 턴]
- 플레이어 단어: "${word}" (시작 글자는 이미 확인됨)
- 이미 사용한 단어: ${usedTxt}

[할 일]
1) 플레이어 단어가 유효한지 판정해.
2) 유효하면 네 차례다. "${last}"${d ? ` 또는 두음법칙에 따라 "${d}"` : ""}(으)로 시작하는 유효한 명사를 하나 골라. 이미 사용한 단어와 플레이어 단어는 쓸 수 없다. 정말 없으면 ai를 null로 해.
3) ${GUIDE[mode] || GUIDE.normal}

${TAGS}

JSON만 출력해. 설명이나 코드블록 없이 이 형태 그대로:
{"valid":true,"reason":"","meaning":"","rare":false,"trend":false,"ai":{"word":"단어","meaning":"","rare":false,"trend":false}}
무효일 때: {"valid":false,"reason":"20자 이내 이유","meaning":"","rare":false,"trend":false,"ai":null}`;
  }
  if (kind === "judge") {
    return `너는 한국어 끝말잇기 게임의 심판이다.

${RULE_TEXT}

- 판정할 단어: "${word}" (시작 글자는 이미 확인됨)
- 이미 사용한 단어: ${usedTxt}

${TAGS}
JSON만 출력해. 설명이나 코드블록 없이:
{"valid":true,"reason":"","meaning":"","rare":false,"trend":false}
무효일 때 reason은 20자 이내 이유.`;
  }
  // hint
  return `한국어 끝말잇기 힌트. "${allowed.join('" 또는 "')}"(으)로 시작하는 흔한 한국어 명사 하나를 골라. 고유명사 금지. 다음 단어는 금지: ${usedTxt}. JSON만: {"word":"단어"}`;
}

// 아주 단순한 IP별 요청 제한 (서버 인스턴스마다 따로 셈 — 과금 폭주 방지용 안전장치)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || { n: 0, t: now };
  if (now - w.t > 60_000) { w.n = 0; w.t = now; }
  w.n++; hits.set(ip, w);
  if (hits.size > 5000) hits.clear();
  return w.n > Number(process.env.RATE_LIMIT_PER_MIN || 40);
}

// 판정 캐시: 같은 단어를 여러 학생이 쓰면 API를 다시 부르지 않음 (무료 한도 절약)
const verdicts = new Map();
function remember(word, v) {
  if (!v || typeof v.valid !== "boolean") return;
  verdicts.set(word, { valid: v.valid, reason: v.reason || "", meaning: v.meaning || "", rare: !!v.rare, trend: !!v.trend });
  if (verdicts.size > 3000) verdicts.delete(verdicts.keys().next().value);
}

// 429·5xx면 한 번 더 시도, 12초 넘으면 끊기
async function withRetry(fn) {
  for (let i = 0; i < 2; i++) {
    const out = await fn();
    const retryable = out.status === 429 || (out.status === 502 && out.body && out.body.status >= 500);
    if (!retryable || i === 1) return out;
    await new Promise((r) => setTimeout(r, 900));
  }
}
async function timedFetch(url, opts, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

function parseJSON(text) {
  let t = String(text || "");
  const think = t.lastIndexOf("</think>");
  if (think >= 0) t = t.slice(think + 8);
  t = t.replace(/```json|```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? t.slice(a, b + 1) : t);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const upstageKey = process.env.UPSTAGE_API_KEY, anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!upstageKey && !anthropicKey) return res.status(503).json({ error: "ai_unavailable", detail: "UPSTAGE_API_KEY or ANTHROPIC_API_KEY not set" });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0] || "anon";
  if (limited(ip)) return res.status(429).json({ error: "rate_limited" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const kind = ["turn", "judge", "hint"].includes(body.kind) ? body.kind : null;
  const word = String(body.word || "");
  const used = (Array.isArray(body.used) ? body.used : []).map(String).filter((w) => HANGUL.test(w)).slice(-80);
  const mode = ["easy", "normal", "hell"].includes(body.mode) ? body.mode : "normal";
  const allowed = (Array.isArray(body.allowed) ? body.allowed : []).map(String).filter((c) => /^[가-힣]$/.test(c)).slice(0, 2);
  if (!kind) return res.status(400).json({ error: "bad kind" });
  if (kind !== "hint" && !HANGUL.test(word)) return res.status(400).json({ error: "bad word" });
  if (kind === "hint" && !allowed.length) return res.status(400).json({ error: "bad allowed" });

  const cached = kind !== "hint" ? verdicts.get(word) : null;
  if (cached && kind === "judge") return res.status(200).json({ ...cached, cached: true });
  if (cached && kind === "turn" && !cached.valid) return res.status(200).json({ ...cached, ai: null, cached: true });

  const prompt = buildPrompt(kind, word, used, mode, allowed);
  try {
    const out = await withRetry(() => (upstageKey ? callUpstage(upstageKey, prompt) : callAnthropic(anthropicKey, prompt)));
    if (out.status) return res.status(out.status).json(out.body);
    const result = parseJSON(out.text);
    if (kind !== "hint") {
      remember(word, result);
      if (kind === "turn" && result.ai && HANGUL.test(String(result.ai.word || ""))) remember(result.ai.word, { valid: true, ...result.ai });
    }
    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: "judge_failed" });
  }
}

async function callUpstage(key, prompt) {
  const body = {
    model: UPSTAGE_MODEL,
    max_tokens: 1500,          // Solar Pro 4는 생각(reasoning) 토큰도 여기에 포함됨
    temperature: 0.6,
    frequency_penalty: 0,      // 기본값 1.1은 JSON 키 반복을 방해할 수 있음
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "너는 한국어 끝말잇기 심판이다. 요청한 JSON 객체 하나만 출력한다." },
      { role: "user", content: prompt },
    ],
  };
  if (process.env.UPSTAGE_REASONING) body.reasoning_effort = process.env.UPSTAGE_REASONING;
  const r = await timedFetch("https://api.upstage.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 429) return { status: 429, body: { error: "rate_limited" } };
  if ([401, 402, 403].includes(r.status)) return { status: 503, body: { error: "ai_unavailable", provider: "upstage", status: r.status, detail: (await r.text()).slice(0, 300) } };
  if (!r.ok) return { status: 502, body: { error: "upstream", provider: "upstage", status: r.status, detail: (await r.text()).slice(0, 300) } };
  const data = await r.json();
  return { text: data.choices?.[0]?.message?.content || "" };
}

async function callAnthropic(key, prompt) {
  const r = await timedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 400, messages: [{ role: "user", content: prompt }] }),
  });
  if (r.status === 429) return { status: 429, body: { error: "rate_limited" } };
  if ([401, 402, 403].includes(r.status)) return { status: 503, body: { error: "ai_unavailable", provider: "anthropic", status: r.status } };
  if (!r.ok) return { status: 502, body: { error: "upstream", provider: "anthropic", status: r.status, detail: (await r.text()).slice(0, 300) } };
  const data = await r.json();
  return { text: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("") };
}
