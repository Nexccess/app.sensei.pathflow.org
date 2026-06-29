// api/stripe-webhook.js
// Stripe決済完了 → 利用者管理シートに登録
import Stripe from 'stripe';
import { google } from 'googleapis';

const PLAN_MAP = {
  // Stripe商品名からプランを判定
  'スターター': 'starter',
  'starter':    'starter',
  'スタンダード': 'standard',
  'standard':   'standard',
  'プレミアム':  'premium',
  'premium':    'premium',
};

function getPlan(productName) {
  const name = productName || '';
  for (const [key, val] of Object.entries(PLAN_MAP)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return 'starter';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  // 対象イベント：新規契約・更新
  if (!['customer.subscription.created', 'customer.subscription.updated'].includes(event.type)) {
    return res.status(200).json({ received: true });
  }

  const subscription = event.data.object;
  if (subscription.status !== 'active') {
    return res.status(200).json({ received: true });
  }

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // 顧客情報取得
    const customer = await stripe.customers.retrieve(subscription.customer);
    const email = customer.email;
    if (!email) return res.status(200).json({ received: true });

    // プラン判定
    const productId = subscription.items.data[0]?.price?.product;
    const product = await stripe.products.retrieve(productId);
    const plan = getPlan(product.name);

    // Google Sheetsに記録
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const SHEET_ID = process.env.APP_SPREADSHEET_ID;
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

    // ヘッダー確認
    const check = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '利用者管理!A1',
    });
    const first = ((check.data.values || [[]])[0] || [])[0];
    if (!first) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: '利用者管理!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['メールアドレス', '登録日時', 'プラン', 'Stripe顧客ID']] },
      });
    }

    // 既存ユーザーか確認
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: '利用者管理!A:D',
    });
    const rows = existing.data.values || [];
    const existingRow = rows.findIndex(r =>
      (r[0] || '').toLowerCase().trim() === email.toLowerCase().trim()
    );

    if (existingRow > 0) {
      // 既存ユーザー → プラン更新
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `利用者管理!C${existingRow + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[plan]] },
      });
    } else {
      // 新規ユーザー → 追加
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: '利用者管理!A1',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[email, now, plan, subscription.customer]] },
      });
    }

    console.log(`[webhook] ${email} → ${plan}`);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Raw bodyを取得（Stripe署名検証に必要）
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
