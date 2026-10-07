// netlify/functions/checkout.js
// Pro Shop checkout: goods and classes, paid in full through Stripe Checkout.
// Netlify environment variable required: STRIPE_SECRET_KEY (restricted key, Checkout Sessions: Write)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Prices live here, on the server, so nobody can change them in the browser. Amounts in cents.
const CATALOG = {
  peace:  { name: 'Protected Peace Crew Sweatshirt',                           price: 8888,  type: 'goods' },
  goalie: { name: 'Built to Hold Hoodie by Dedicated Goalie',                  price: 8888,  type: 'goods' },
  kanga:  { name: 'Salt & Pepper Kanga Hoodie by Roots and The Kitchen Dink',  price: 18888, type: 'goods' },
  a1a:    { name: 'A1A Rollerblade Ride (class)',                              price: 3000,  type: 'class' },
  aero:   { name: 'Oceanside Aerobics (class)',                                price: 3000,  type: 'class' },
  pullup: { name: 'Pull-Up Party (class)',                                     price: 3000,  type: 'class' },
  beachrun: { name: 'Beach Run (class)',                                       price: 3000,  type: 'class' },
};
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });

  let items;
  try {
    ({ items } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid request.' });
  }
  if (!Array.isArray(items) || items.length === 0) return json(400, { error: 'Your bag is empty.' });
  if (items.length > 50) return json(400, { error: 'That is a great many items. Please contact the Concierge.' });

  // Combine identical items (same product and size) into one line with a quantity.
  const lines = new Map();
  for (const item of items) {
    const product = CATALOG[item && item.id];
    if (!product) return json(400, { error: 'An item in your bag is no longer available.' });
    let size = null;
    if (product.type === 'goods') {
      size = SIZES.includes(item.size) ? item.size : null;
      if (!size) return json(400, { error: `Please choose a size for ${product.name}.` });
    }
    const key = `${item.id}|${size || ''}`;
    const line = lines.get(key) || { product, size, qty: 0 };
    line.qty += 1;
    lines.set(key, line);
  }

  const line_items = [...lines.values()].map(({ product, size, qty }) => ({
    price_data: {
      currency: 'usd',
      unit_amount: product.price,
      product_data: { name: size ? `${product.name} (Size: ${size})` : product.name },
    },
    quantity: qty,
  }));
  const hasGoods = [...lines.values()].some((l) => l.product.type === 'goods');

  const origin = event.headers.origin || process.env.URL || 'https://aspenbeachclub.com';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      ...(hasGoods ? { shipping_address_collection: { allowed_countries: ['US'] } } : {}),
      phone_number_collection: { enabled: true },
      success_url: `${origin}/thankyou.html?type=order&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/#proshop`,
    });
    return json(200, { url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    return json(500, { error: 'Checkout could not open. Please try again.' });
  }
};
