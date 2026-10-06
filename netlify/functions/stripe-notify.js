// netlify/functions/stripe-notify.js
// Emails the Club whenever something happens in Stripe: orders, session holds,
// captures, released holds, refunds, and NAMASTAY memberships starting or ending.
//
// Netlify environment variables:
//   STRIPE_SECRET_KEY      (already set)
//   STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe webhook
//   RESEND_API_KEY         re_... from resend.com
//   NOTIFY_TO              optional, defaults to info@aspenbeachclub.com
//   NOTIFY_FROM            optional, defaults to Resend's test sender

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const TO = process.env.NOTIFY_TO || 'info@aspenbeachclub.com';
const FROM = process.env.NOTIFY_FROM || 'Aspen Beach Club <onboarding@resend.dev>';
const DASH = 'https://dashboard.stripe.com';

const money = (cents, cur = 'usd') =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: cur.toUpperCase() });
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function send(subject, rows, link) {
  const table = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#5A5148;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#1C2C3C">${esc(v).replace(/\n/g, '<br>')}</td></tr>`)
    .join('');
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1C2C3C">
    <p style="font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#A94F2C;margin:0 0 6px">Aspen Beach Club</p>
    <h2 style="margin:0 0 16px;font-size:20px">${esc(subject)}</h2>
    <table style="border-collapse:collapse">${table}</table>
    ${link ? `<p style="margin-top:20px"><a href="${link}" style="color:#1C2C3C">Open in Stripe</a></p>` : ''}
  </div>`;
  const text = rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') + (link ? `\n\nOpen in Stripe: ${link}` : '');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [TO], subject: `ABC: ${subject}`, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function lineItems(sessionId) {
  try {
    const li = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 50 });
    return li.data.map((i) => `${i.quantity} × ${i.description} (${money(i.amount_total, i.currency)})`).join('\n');
  } catch (e) {
    return '(see Stripe for items)';
  }
}

async function customerEmail(customerId) {
  if (!customerId) return '';
  try {
    const c = await stripe.customers.retrieve(customerId);
    return [c.name, c.email].filter(Boolean).join(', ');
  } catch (e) {
    return customerId;
  }
}

function address(a) {
  if (!a) return '';
  return [a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(' '), a.country].filter(Boolean).join('\n');
}

async function handle(evt) {
  const o = evt.data.object;

  switch (evt.type) {
    case 'checkout.session.completed': {
      const who = o.customer_details || {};
      const buyer = [who.name, who.email, who.phone].filter(Boolean).join(', ');
      if (o.mode === 'subscription') {
        return send('New NAMASTAY membership', [
          ['Member', buyer],
          ['Plan', await lineItems(o.id)],
          ['First payment', money(o.amount_total || 0, o.currency)],
        ], o.subscription ? `${DASH}/subscriptions/${o.subscription}` : null);
      }
      const pi = o.payment_intent;
      const link = pi ? `${DASH}/payments/${pi}` : null;
      if (o.metadata && o.metadata.session_date) {
        const m = o.metadata;
        return send(`Session hold: ${m.guest_name}, ${m.session_date} ${m.session_time}`, [
          ['Status', `${money(o.amount_total, o.currency)} HELD, not charged. Capture once an instructor is confirmed, or cancel to release.`],
          ['Guest', `${m.guest_name}, ${(who.email || '')}, ${m.guest_phone}`],
          ['When', `${m.session_date} at ${m.session_time} (${m.length})`],
          ['Instructor', m.instructor],
          ['Where', `${m.location}: ${m.where}`],
          ['Reminder', 'Card holds expire after 7 days.'],
        ], link);
      }
      const ship = (o.collected_information && o.collected_information.shipping_details) || o.shipping_details;
      return send(`New Pro Shop order, ${money(o.amount_total, o.currency)}`, [
        ['Customer', buyer],
        ['Items', await lineItems(o.id)],
        ['Total', money(o.amount_total, o.currency)],
        ['Ship to', ship ? `${ship.name}\n${address(ship.address)}` : 'No shipping (classes only)'],
      ], link);
    }

    case 'charge.captured':
      return send(`Session hold captured, ${money(o.amount_captured, o.currency)} charged`, [
        ['Payment', o.description],
        ['Guest', [o.metadata && o.metadata.guest_name, o.billing_details && o.billing_details.email].filter(Boolean).join(', ')],
      ], `${DASH}/payments/${o.payment_intent}`);

    case 'payment_intent.canceled':
      if (o.capture_method !== 'manual') return null;
      return send(`Session hold released, ${money(o.amount, o.currency)}`, [
        ['Payment', o.description],
        ['Guest', o.metadata && o.metadata.guest_name],
        ['Reason', o.cancellation_reason],
        ['Note', 'The card was not charged.'],
      ], `${DASH}/payments/${o.id}`);

    case 'charge.refunded': {
      const full = o.amount_refunded >= o.amount;
      return send(`${full ? 'Refund' : 'Partial refund'}: ${money(o.amount_refunded, o.currency)}`, [
        ['Refunded', `${money(o.amount_refunded, o.currency)} of ${money(o.amount, o.currency)}`],
        ['Customer', [o.billing_details && o.billing_details.name, o.billing_details && o.billing_details.email].filter(Boolean).join(', ')],
        ['Payment', o.description || ''],
      ], `${DASH}/payments/${o.payment_intent}`);
    }

    case 'customer.subscription.updated': {
      const prev = evt.data.previous_attributes || {};
      if (!('cancel_at_period_end' in prev)) return null;
      const level = (o.metadata && o.metadata.level) || 'NAMASTAY';
      const ends = o.current_period_end || (o.items && o.items.data[0] && o.items.data[0].current_period_end);
      return send(o.cancel_at_period_end ? `Membership cancellation scheduled: ${level}` : `Membership cancellation withdrawn: ${level}`, [
        ['Member', await customerEmail(o.customer)],
        ['Ends', o.cancel_at_period_end && ends ? new Date(ends * 1000).toDateString() : ''],
        ['Reason', o.cancellation_details && (o.cancellation_details.feedback || o.cancellation_details.comment)],
      ], `${DASH}/subscriptions/${o.id}`);
    }

    case 'customer.subscription.deleted':
      return send(`Membership ended: ${(o.metadata && o.metadata.level) || 'NAMASTAY'}`, [
        ['Member', await customerEmail(o.customer)],
        ['Reason', o.cancellation_details && (o.cancellation_details.feedback || o.cancellation_details.reason)],
      ], `${DASH}/subscriptions/${o.id}`);

    case 'invoice.payment_failed':
      return send(`Membership payment failed, ${money(o.amount_due, o.currency)}`, [
        ['Member', [o.customer_name, o.customer_email].filter(Boolean).join(', ')],
        ['Note', 'Stripe will retry the card automatically.'],
      ], o.hosted_invoice_url || null);

    default:
      return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  let evt;
  try {
    evt = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature check failed:', err.message);
    return { statusCode: 400, body: 'Invalid signature' };
  }

  try {
    await handle(evt);
  } catch (err) {
    console.error(`Notification for ${evt.type} failed:`, err);
    return { statusCode: 500, body: 'Notification failed' }; // Stripe will retry
  }
  return { statusCode: 200, body: 'ok' };
};
