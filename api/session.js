const MODEL = 'gpt-realtime-translate';
const OPENAI_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets';

const ALLOWED_LANGUAGES = new Set([
  'ko', 'en', 'ja', 'zh', 'es', 'fr', 'de', 'it',
  'pt', 'ru', 'hi', 'id', 'vi',
]);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const targetLanguage = (body.targetLanguage || '').toLowerCase().trim();

  if (!ALLOWED_LANGUAGES.has(targetLanguage)) {
    res.status(400).json({
      error: `지원하지 않는 출력 언어입니다. 허용: ${[...ALLOWED_LANGUAGES].join(', ')}`,
    });
    return;
  }

  try {
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          model: MODEL,
          audio: {
            // 입력 받아쓰기(whisper) 비활성 — 텍스트 자막을 안 쓰므로 비용 절감
            output: { language: targetLanguage },
          },
        },
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      res.status(upstream.status).json({
        error: 'OpenAI 토큰 발급 실패',
        detail: data,
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: '서버 오류', detail: String(err) });
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
