#!/usr/bin/env node
// Resolve each MONDAYS product to its Shopify variant so the catalog can link
// straight to the store with the item in the cart (cart permalink, /cart/<id>:1).
// Writes data/buy-links.json; snapshot stays dated like the rest of data/.
import fs from "node:fs/promises";
import path from "node:path";

const STORE = "https://www.chewmondays.com";
const root = path.resolve(import.meta.dirname, "..");
const catalog = JSON.parse(await fs.readFile(path.join(root, "data/products.json"), "utf8"));

const buy = { source: STORE, retrieved: new Date().toISOString().slice(0, 10), products: {} };
for (const product of catalog.products) {
  const res = await fetch(`${STORE}/products/${product.handle}.js`, { headers: { "user-agent": "terpedia-mondays-ingest" } });
  if (!res.ok) { console.warn(`  ! ${product.handle}: HTTP ${res.status}`); continue; }
  const data = await res.json();
  const variants = data.variants || [];
  const variant = variants.find((v) => v.available) || variants[0];
  if (!variant) { console.warn(`  ! ${product.handle}: no variants`); continue; }
  buy.products[product.handle] = {
    variant_id: variant.id,
    title: data.title,
    price_cents: Number(variant.price) || null,
    in_stock: Boolean(variant.available),
    product_url: `${STORE}/products/${product.handle}`,
    cart_url: `${STORE}/cart/${variant.id}:1`,
  };
  console.log(`  ${product.handle}: variant ${variant.id}${variant.available ? "" : " (out of stock)"}`);
}

await fs.writeFile(path.join(root, "data/buy-links.json"), `${JSON.stringify(buy, null, 2)}\n`);
console.log(`wrote data/buy-links.json (${Object.keys(buy.products).length} products)`);
