const MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-1.5-flash-latest'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic, tone, length, purpose, reader_level, risk_level } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'テーマを入力してください' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'APIキーが設定されていません' });
  }

  // 文字数→読了時間マッピング
  const readingTime = {
    '400':  '約2分',
    '800':  '約3〜4分',
    '1200': '約5分'
  };
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
必ず以下の形式で書き出すこと。
「今日は〇〇について、${timeLabel}でご確認いただける内容です。」
・〇〇はテーマを自然に要約した表現にすること
・この一文の直後から本文に入ること

【出力条件】
・文字数：${length}文字前後
・見出しは【見出し】形式で記載（markdownのハッシュ記号は使わない）
・HTML装飾なし、プレーンテキストで出力
・マークダウン記法（**太字**、*斜体*、- リストなど）は一切使わないこと
・最後は必ず「気になる点や、もう少し詳しく聞いてみたいことがあれば、いつでもどうぞ。」で締めること

【テーマ】
${topic}`;

  let lastError = null;

  for (const model of MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
        const msg = err.error?.message || `HTTP ${response.status}`;
        if (response.status === 429 || response.status === 503 || response.status === 500) {
          lastError = msg;
          console.warn(`[${model}] fallback: ${msg}`);
          continue;
        }
        throw new Error(msg);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) throw new Error('生成結果が空です');

      const NG_WORDS = ['すべき', '必要があります', '必ず', '必須', '絶対に'];
      const ngHits = NG_WORDS.filter(w => text.includes(w));

      console.log(`[${model}] success`);
      return res.status(200).json({ text, ngHits, model });

    } catch (err) {
      lastError = err.message;
      console.warn(`[${model}] error: ${err.message}`);
      if (err.message.includes('API_KEY') || err.message.includes('INVALID_ARGUMENT')) {
        return res.status(500).json({ error: 'APIエラーが発生しました: ' + err.message });
      }
      continue;
    }
  }

  console.error('All models failed:', lastError);
  return res.status(503).json({
    error: 'しばらく時間をおいて再度お試しください。（サービスが混み合っています）'
  });
}
