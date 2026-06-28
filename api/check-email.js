// api/check-email.js
// デモ利用者のメアド1回制限 + Google Sheets記録
import { google } from 'googleapis';

const SHEET_NAME = 'デモ予約';
const HEADERS    = ['登録日時', 'メールアドレス', 'ステータス'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'メールアドレスが必要です' });
  }

  const SHEET_ID = process.env.SENSEI_DEMO_SPREADSHEET_ID;
  if (!SHEET_ID) {
    return res.status(500).json({ error: 'スプレッドシートIDが設定されていません' });
  }

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // ── 1. ヘッダー行チェック（初回のみ自動挿入）
    const checkRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
    });
    const firstCell = ((checkRes.data.values || [[]])[0] || [])[0];
    if (!firstCell) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [HEADERS] },
      });
    }

    // ── 2. 既存メアドを全件取得して重複チェック
    const dataRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!B:B`,
    });
    const rows = dataRes.data.values || [];
    const emails = rows.flat().map(e => e.toLowerCase().trim());
    const normalizedEmail = email.toLowerCase().trim();

    if (emails.includes(normalizedEmail)) {
      // 利用済み
      return res.status(200).json({ allowed: false });
    }

    // ── 3. 未登録 → Sheetsに記録
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[now, normalizedEmail, '利用済み']],
      },
    });

    return res.status(200).json({ allowed: true });

  } catch (err) {
    console.error('check-email error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
