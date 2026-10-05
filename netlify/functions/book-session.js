// netlify/functions/book-session.js
// NAMASTAY single session ($150). The card is AUTHORIZED (held) at booking, not charged.
// You charge it from the Stripe dashboard once you confirm an instructor: Payments > the payment > Capture.
// If you can't fill the session, cancel the payment there and the hold is released.
// Card holds expire after 7 days, which matches the 7-day booking window for single sessions.
// Netlify environment variable required: STRIPE_SECRET_KEY (restricted key, Checkout Sessions: Write)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE = 15000; // $150.00
const TIMES = ['6:00 AM','7:00 AM','8:00 AM','9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM','9:00 PM','10:00 PM'];
const INSTRUCTORS = ['Maya', 'Julien', 'Priya', 'Sofia'];

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  let d;
  try {
    d = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request.' });
  }

  const b = {
    name: clean(d.name), email: clean(d.email), phone: clean(d.phone, 40),
    date: clean(d.date, 10), dateLabel: clean(d.dateLabel, 40), time: clean(d.time, 10),
    instructor: clean(d.instructor, 40), location: clean(d.location, 20),
    hotel: clean(d.hotel), room: clean(d.room, 40), address: clean(d.address, 300),
  };

  if (!b.name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email) || !b.phone) {
    return json(400, { error: 'Please go back and add your name, email and phone.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !TIMES.includes(b.time) || !INSTRUCTORS.includes(b.instructor)) {
    return json(400, { error: 'Please choose a date, time and instructor.' });
  }
  // Single sessions: today through 7 days out (a day of slack either side for time zones).
  const day = new Date(b.date + 'T12:00:00Z');
  const diffDays = (day - Date.now()) / 86400000;
  if (isNaN(diffDays) || diffDays < -1.5 || diffDays > 8) {
    return json(400, { error: 'Single sessions can be booked up to 7 days ahead.' });
  }
  const where = b.location === 'Home'
    ? b.address
    : (b.hotel && b.room ? `${b.hotel}, room ${b.room}` : '');
  if (!where) return json(400, { error: 'Please add where your session takes place.' });

  const summary = `${b.dateLabel || b.date} at ${b.time} with ${b.instructor}, 60 min. ${b.location}: ${where}`;
  const metadata = {
    guest_name: b.name, guest_phone: b.phone, session_date: b.date, session_time: b.time,
    instructor: b.instructor, length: '60 min', location: b.location, where: where.slice(0, 450),
  };

  const origin = event.headers.origin || process.env.URL || 'https://aspenbeachclub.com';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: b.email,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: PRICE,
          product_data: { name: 'NAMASTAY Single Session (60 minutes)', description: summary.slice(0, 500) },
        },
        quantity: 1,
      }],
      payment_method_types: ['card'],
      payment_intent_data: {
        capture_method: 'manual',
        description: `NAMASTAY session: ${summary}`.slice(0, 1000),
        metadata,
      },
      metadata,
      custom_text: {
        submit: { message: 'Your card is held now and charged $150 only once your session is confirmed.' },
      },
      success_url: `${origin}/thankyou.html?type=session&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/namastay.html`,
    });
    return json(200, { url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return json(500, { error: 'We could not open checkout. Please try again in a moment.' });
  }
};
