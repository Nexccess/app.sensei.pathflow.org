// api/auth.js
// メアドでStripe契約確認 + 残回数返却
import Stripe from 'stripe';
import { google } from 'googleapis';

const PLAN_LIMITS = {
  starter:   20,
  standard:  40,
  premium:   60
};

// Stripeの商品名からプランを判定
function getPlanFromProduct(productName) {
  const name = (productName || '').toLowerCase();
  if (name.includes('premium') || name.includes('プレミアム')) return 'premium';
  if (name.includes('standard') || name.includes('スタンダード')) return 'standard';
  return 'starter';
}

// 今月の利用回数をSheetsから取得
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
    // A列:日時 B列:メアド C列:利用
    const count = rows.filter(row =>
      (row[1] || '').toLowerCase().trim() === email.toLowerCase().trim() &&
      (row[0] || '').startsWith(ym)
    ).length;
    return count;
  } catch {
    return 0;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'メールアドレスが必要です' });
  }

  try {
    // ── 1. Stripe契約確認
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const customers = await stripe.customers.list({ email: email.toLowerCase().trim(), limit: 5 });

    if (!customers.data.length) {
      return res.status(200).json({ authorized: false, message: 'ご契約が確認できませんでした。' });
    }

    // アクティブなサブスクリプションを確認
    let activePlan = null;
    for (const customer of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: customer.id,
        status: 'active',
        limit: 5,
      });
      if (subs.data.length) {
        const sub = subs.data[0];
        const productId = sub.items.data[0]?.price?.product;
        const product = await stripe.products.retrieve(productId);
        activePlan = getPlanFromProduct(product.name);
        break;
      }
    }

    if (!activePlan) {
      return res.status(200).json({ authorized: false, message: 'アクティブなご契約が確認できませんでした。' });
    }

    // ── 2. 残回数確認
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const used = await getUsageThisMonth(sheets, email);
    const limit = PLAN_LIMITS[activePlan];
    const remaining = Math.max(0, limit - used);

    return res.status(200).json({
      authorized: true,
      plan: activePlan,
      limit,
      used,
      remaining
    });

  } catch (err) {
    console.error('auth error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
