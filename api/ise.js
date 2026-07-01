// api/use.js
// 残回数確認 → 生成 → 利用履歴記録
import { google } from 'googleapis';

const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-1.5-flash-latest'
];

const PLAN_LIMITS = { starter: 20, standard: 40, premium: 60 };

async function getUsageThisMonth(sheets, email) {
  const SHEET_ID = process.env.APP_SPREADSHEET_ID;
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '利用履歴!A:C',
    });
    const rows = res.data.values || [];
    return rows.filter(row =>
      (row[1] || '').toLowerCase().trim() === email.toLowerCase().trim() &&
      (row[0] || '').startsWith(ym)
    ).length;
  } catch { return 0; }
}

async function recordUsage(sheets, email, topic) {
  const SHEET_ID = process.env.APP_SPREADSHEET_ID;
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  // ヘッダー確認
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: '利用履歴!A1',
  });
  const first = ((check.data.values || [[]])[0] || [])[0];
  if (!first) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: '利用履歴!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['利用日時', 'メールアドレス', 'テーマ']] },
    });
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: '利用履歴!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[now, email.toLowerCase().trim(), topic]] },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, topic, tone, length, purpose, reader_level, risk_level } = req.body;
  if (!email || !topic) {
    return res.status(400).json({ error: 'email and topic required' });
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // ── 1. 利用者管理シートからプラン確認
    const SHEET_ID = process.env.APP_SPREADSHEET_ID;
    const userRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '利用者管理!A:C',
    });
    const userRows = userRes.data.values || [];
    const userRow = userRows.find(r =>
      (r[0] || '').toLowerCase().trim() === email.toLowerCase().trim()
    );

    const plan = userRow ? (userRow[2] || 'starter').toLowerCase() : 'starter';
    const limit = PLAN_LIMITS[plan] || 20;

    // ── 2. 今月の利用回数確認
    const used = await getUsageThisMonth(sheets, email);
    if (used >= limit) {
      return res.status(403).json({ error: '今月の利用上限に達しました', remaining: 0 });
    }

    // ── 3. AI生成
    const readingTime = { '400': '約2分', '800': '約3〜4分', '1200': '約5分' };
    const timeLabel = readingTime[String(length)] || '数分';

    const prompt = `あなたは士業事務所（税理士・行政書士・社労士・弁護士など）が顧問先に送る通信文・メルマガを作成するAIです。
以下の制約を必ず守ってください。

【厳守事項】
・個別の助言や結論は禁止
・断定表現は禁止（「〜すべき」「〜必要」「必ず」などは使わない）
・脱法・裏技表現は禁止
・他者否定は禁止
・不安を過度に煽らない
・数値・税率・具体的期限は記載しない

【立場】
あなたは中立的な解説者です。答えを出さず、読者が自分で考えるための材料を整理してください。

【文章条件】
・トーン：${tone}
・想定読者：${reader_level}
・目的：${purpose}
・リスク許容度：${risk_level}

【書き出し指示】
必ず「今日は〇〇について、${timeLabel}でご確認いただける内容です。」という形式で書き出すこと。
・〇〇はテーマを自然に要約した表現にすること

【出力条件】
・文字数：${length}文字前後
・見出しは【見出し】形式で記載（markdownのハッシュ記号は使わない）
・HTML装飾なし、プレーンテキストで出力
・マークダウン記法（**太字**、*斜体*、- リストなど）は一切使わないこと
・最後は必ず「気になる点や、もう少し詳しく聞いてみたいことがあれば、いつでもどうぞ。」で締めること

【テーマ】
${topic}`;

    let text = null;
    let lastError = null;

    for (const model of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.6, maxOutputTokens: 4096 }
          })
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          lastError = err.error?.message || `HTTP ${response.status}`;
          if ([429, 503, 500].includes(response.status)) continue;
          throw new Error(lastError);
        }
        const data = await response.json();
        text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (!text) throw new Error('生成結果が空です');
        break;
      } catch (e) {
        lastError = e.message;
        continue;
      }
    }

    if (!text) {
      return res.status(503).json({ error: 'しばらく時間をおいて再度お試しください。' });
    }

    const NG_WORDS = ['すべき', '必要があります', '必ず', '必須', '絶対に'];
    const ngHits = NG_WORDS.filter(w => text.includes(w));

    // ── 4. 利用履歴を記録
    await recordUsage(sheets, email, topic);

    const remaining = Math.max(0, limit - used - 1);

    return res.status(200).json({ text, ngHits, remaining, plan });

  } catch (err) {
    console.error('use error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
