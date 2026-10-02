/**
 * Synthetic data at production scale, for measuring — never for a real shop.
 *
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/manifest_scale \
 *     npm run db:seed:scale -- --products 5000 --customers 20000 --orders 100000
 *
 * Flags: --products, --customers, --orders (defaults 5000 / 20000 / 100000),
 * --create (create the database if it does not exist), --reset (empty it
 * first). The target must pass `assertScratchDatabase`, and the script also
 * refuses a database holding any order it did not generate itself.
 *
 * The data mirrors the shape used in docs/INITIAL_TECHNICAL_AUDIT.md: a
 * 5 → 30 → 150 category tree, three specifications per shelf, one to six
 * variants per product plus 250 on every thousandth, five images each,
 * one address per customer, one to three lines per order over two years,
 * reviews on delivered purchases, and audit rows. Search index rows are built
 * by the application's own triggers.
 */
import "../lib/load-env";
import postgres from "postgres";
import { migratePostgres } from "./migrator";
import { assertScratchDatabase } from "./scratch-guard";

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 5_000_000) {
    throw new Error(`--${name} must be a whole number between 1 and 5,000,000.`);
  }
  return value;
}

const has = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const url = process.env.DATABASE_URL;
  const target = assertScratchDatabase(url);
  const products = flag("products", 5000);
  const customers = flag("customers", 20000);
  const orderCount = flag("orders", 100000);

  if (has("create")) {
    const admin = postgres(url!.replace(/\/[^/?]*(\?|$)/, "/postgres$1"), { max: 1, onnotice: () => {} });
    const exists = await admin`select 1 from pg_database where datname = ${target.database}`;
    // UTF8 explicitly, as e2e/prepare-db.ts: a Windows cluster defaults to WIN1252.
    if (exists.length === 0) {
      await admin.unsafe(`create database "${target.database}" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
    }
    await admin.end();
  }

  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  const step = async (label: string, statement: string) => {
    const started = Date.now();
    const result = await sql.unsafe(statement);
    console.log(`${String(Date.now() - started).padStart(7)} ms  ${label}${result.count ? ` (${result.count})` : ""}`);
  };

  await migratePostgres(sql, { log: () => undefined });

  const [{ foreign }] = await sql<{ foreign: number }[]>`
    select count(*)::int as foreign from orders where order_number not like 'ORD-S-%'`;
  if (foreign > 0) {
    throw new Error(`Refusing: ${target.database} holds ${foreign} orders this generator did not create.`);
  }

  if (has("reset")) {
    await step("reset", `truncate table audit_log, reviews, payments, order_status_history, order_items, orders,
      cart_items, carts, addresses, sessions, users, variant_option_values, attribute_values, product_attributes,
      attributes, variant_images, product_images, product_variants, product_search_words, product_search_queue,
      product_search, products, category_attributes, categories restart identity cascade`);
  }

  const [{ existing }] = await sql<{ existing: number }[]>`select count(*)::int as existing from products`;
  if (existing > 0) {
    throw new Error(`${target.database} already has products. Pass --reset to regenerate.`);
  }

  await step("session", "set synchronous_commit = off");
  await step("categories", `insert into categories (parent_id, name, slug, sort_order)
    select null, 'Root '||r, 'root-'||r, r from generate_series(1,5) r`);
  await step("subcategories", `insert into categories (parent_id, name, slug, sort_order)
    select c.id, c.name||' Sub '||s, c.slug||'-sub-'||s, s from categories c cross join generate_series(1,6) s where c.parent_id is null`);
  await step("shelves", `insert into categories (parent_id, name, slug, sort_order)
    select c.id, c.name||' Leaf '||l, c.slug||'-leaf-'||l, l from categories c cross join generate_series(1,5) l where c.slug like '%-sub-%'`);
  await step("specifications", `insert into category_attributes (category_id, name, data_type, options, sort_order)
    select c.id, spec.name, spec.kind, spec.options, spec.ord from categories c
    cross join (values ('RAM','select','["8","16","32","64"]'::jsonb,0), ('Material','select','["Steel","Plastic","Leather","Cotton","Aluminium"]'::jsonb,1), ('Weight','number',null,2)) as spec(name, kind, options, ord)
    where c.slug like '%-leaf-%'`);

  await step("products", `with leaves as (select id, row_number() over (order by slug) rn from categories where slug like '%-leaf-%'),
    words as (select array['wireless','studio','pro','mini','ultra','classic','portable','organic','premium','smart','compact','deluxe','travel','kitchen','outdoor','gaming','vintage','sport','home','office'] w,
      array['headphones','speaker','backpack','skillet','flask','keyboard','mouse','candy','coffee','sunscreen','lamp','watch','charger','camera','blender','jacket','sneakers','bottle','tent','monitor'] n)
    insert into products (category_id, title, slug, brand, status, description_html, bullet_features, attribute_values, created_at, updated_at)
    select l.id, initcap(w[1+(g*7)%20])||' '||initcap(w[1+(g*13)%20])||' '||initcap(n[1+(g*3)%20])||' '||g, 'p-'||g, 'Brand'||(g%60),
      case when g%20=7 then 'draft' when g%3=0 then 'in_stock' else 'preorder_open' end,
      '<p>'||repeat('Carefully sourced from the United States with a stated arrival window. ',12)||'</p>',
      jsonb_build_array('Feature one for '||g,'Feature two','Feature three'),
      (select jsonb_object_agg(ca.id::text, case ca.name when 'RAM' then to_jsonb((array['8','16','32','64'])[1+g%4])
        when 'Material' then to_jsonb((array['Steel','Plastic','Leather','Cotton','Aluminium'])[1+g%5]) else to_jsonb(100+g%4000) end)
       from category_attributes ca where ca.category_id = l.id),
      now() - (g||' hours')::interval, now()
    from generate_series(1,${products}) g cross join words join leaves l on l.rn = 1 + g % 150`);

  await step("variants", `insert into product_variants (product_id, sku, price_bdt, fulfillment_mode, stock_quantity, preorder_capacity, preorder_reserved, preorder_closes_at, estimated_arrival_from, estimated_arrival_to, weight_grams, sale_price_bdt)
    select p.id, 'SKU-'||substr(p.slug,3)||'-'||v, 50000 + abs(hashtext(p.slug||v)) % 2000000,
      case when p.status='in_stock' then 'in_stock' else 'preorder' end,
      case when p.status='in_stock' then abs(hashtext(p.slug||v))%50 end,
      case when p.status<>'in_stock' then 20 + abs(hashtext(p.slug||v))%200 end,
      case when p.status<>'in_stock' then abs(hashtext(p.slug||v||'r')) % (20 + abs(hashtext(p.slug||v))%200) else 0 end,
      case when p.status<>'in_stock' then now() + (((abs(hashtext(p.slug||v))%60)-5)||' days')::interval end,
      now() + interval '30 days', now() + interval '45 days', 300 + abs(hashtext(p.slug))%3000,
      case when abs(hashtext(p.slug||v))%10=0 then 40000 end
    from products p cross join lateral generate_series(1, case when substr(p.slug,3)::int % 1000 = 0 then 250 else 1 + substr(p.slug,3)::int % 6 end) v`);

  await step("options", `insert into attributes (name, input_type, product_id) select 'Colour','select', id from products`);
  await step("product options", `insert into product_attributes (product_id, attribute_id, sort_order) select product_id, id, 0 from attributes where product_id is not null`);
  await step("option values", `insert into attribute_values (attribute_id, value, sort_order)
    select a.id, case when vv.rn<=12 then (array['Black','White','Red','Blue','Green','Silver','Gold','Grey','Pink','Navy','Olive','Tan'])[vv.rn] else 'Edition '||vv.rn end, vv.rn
    from attributes a join (select product_id, row_number() over (partition by product_id order by sku) rn from product_variants) vv on vv.product_id = a.product_id`);
  await step("variant options", `insert into variant_option_values (variant_id, attribute_id, attribute_value_id)
    select vv.id, a.id, av.id from (select id, product_id, row_number() over (partition by product_id order by sku) rn from product_variants) vv
    join attributes a on a.product_id = vv.product_id join attribute_values av on av.attribute_id = a.id and av.sort_order = vv.rn`);
  await step("images", `insert into product_images (product_id, url, alt_text, sort_order, kind)
    select p.id, '/seed/headphones.svg', p.title||' view '||i, i, 'gallery' from products p cross join generate_series(0,4) i`);

  await step("customers", `insert into users (email, password_hash, role, first_name)
    select 'scale'||g||'@example.test', 'not-a-usable-hash', 'customer', 'Shopper'||g from generate_series(1,${customers}) g`);
  await step("owner", `insert into users (email, password_hash, role, first_name) values ('scale-owner@example.test','not-a-usable-hash','super_admin','Owner')`);
  await step("addresses", `insert into addresses (user_id, recipient_name, phone, address_line1, city, district)
    select id, first_name, '01700000000', 'House 1, Road 2', 'Dhaka', 'Dhaka' from users where role='customer'`);

  await step("orders", `with u as (select row_number() over (order by u.email) n, u.id uid, a.id aid from users u join addresses a on a.user_id=u.id)
    insert into orders (order_number, user_id, status, shipping_address_id, subtotal_bdt, total_bdt, amount_due_now_bdt, idempotency_key, placed_at)
    select 'ORD-S-'||lpad(g::text,7,'0'), u.uid,
      (array['placed','payment_confirmed','sourcing','shipped_from_us','in_bd_customs','out_for_delivery','delivered','delivered','delivered','cancelled'])[1+g%10],
      u.aid, 100000, 100000, 100000, 'scale-'||g, now() - ((g % 730)||' days')::interval - ((g%86400)||' seconds')::interval
    from generate_series(1,${orderCount}) g join u on u.n = 1 + (g::bigint*7919) % ${customers}`);
  await step("order lines", `with v as (select row_number() over (order by v.id) n, v.id, v.price_bdt, p.title, v.fulfillment_mode, v.sku
      from product_variants v join products p on p.id=v.product_id where p.status <> 'draft'),
    total as (select count(*) c from v)
    insert into order_items (order_id, variant_id, title_snapshot, unit_price_bdt, quantity, fulfillment_mode_snapshot, sku_snapshot)
    select o.id, v.id, v.title, v.price_bdt, 1 + i%2, v.fulfillment_mode, v.sku
    from orders o cross join lateral generate_series(1, 1 + abs(hashtext(o.order_number))%3) i
    cross join total join v on v.n = 1 + abs(hashtext(o.order_number||i)) % total.c`);
  await step("status history", `insert into order_status_history (order_id, status, note, created_at) select id, status, 'generated', placed_at from orders`);
  await step("payments", `insert into payments (order_id, kind, provider, provider_ref, method, amount_bdt, status, created_at)
    select id, 'full', 'mock', 'mock_scale_'||replace(id::text,'-',''), 'bkash', amount_due_now_bdt, case when status='placed' then 'initiated' else 'captured' end, placed_at from orders`);
  await step("reviews", `insert into reviews (product_id, user_id, order_item_id, rating, title, body, status)
    select distinct on (o.user_id, v.product_id) v.product_id, o.user_id, oi.id, 1 + abs(hashtext(oi.id::text))%5, 'Good', 'Generated review', 'approved'
    from order_items oi join orders o on o.id=oi.order_id join product_variants v on v.id=oi.variant_id
    where o.status='delivered' order by o.user_id, v.product_id`);
  await step("audit", `insert into audit_log (actor_user_id, action, entity_type, entity_id, before_json, after_json)
    select (select id from users where role='super_admin' limit 1), 'product.updated', 'product', p.id::text, '{"generated":true}', '{"generated":true}'
    from products p cross join generate_series(1,10)`);
  await step("analyze", "analyze");

  const counts = await sql`select
    (select count(*) from products)::int products, (select count(*) from product_variants)::int variants,
    (select count(*) from users)::int users, (select count(*) from orders)::int orders,
    (select count(*) from order_items)::int order_items, (select count(*) from reviews)::int reviews,
    pg_size_pretty(pg_database_size(current_database())) size`;
  console.log(counts[0]);
  await sql.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
