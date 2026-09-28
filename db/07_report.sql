-- =====================================================================
-- 07_report.sql — data model for the monthly GEO report dashboard.
-- Run after 01, 02 and 06. Safe to re-run.
--
--   prompts.is_neutral     → the 17-prompt neutral competitor set (no brand/location terms)
--   competitor_groups      → the tracked competitor set, with every name engines use
--   benchmarks             → baseline / 13 Aug benchmark / report values / targets
--   source_categories      → how cited domains are grouped (owned, IHG, editorial, OTA…)
--   report_notes           → analyst commentary per reporting period
--   v_answer_scores        → per-answer metrics for the hotel (Rankscale's formula)
--   v_competitor_answer_scores → the same metrics for each tracked competitor
--
-- Metric definitions (these reproduce Rankscale's own numbers):
--   answer score  = 100 / (1 + 0.1 × (rank − 1)) when mentioned, else 0
--                   (rank 1 → 100, rank 2 → 90.9, rank 3 → 83.3 … exactly as in the export)
--   Visibility    = average answer score across all answers
--   Detection     = % of answers that mention the brand
--   Avg position  = average rank, only where mentioned
--   Top 3         = % of answers where the brand ranks 1–3
--   Sentiment     = average sentiment × 100, only where mentioned
-- =====================================================================

-- ---------------------------------------------------------------------
-- Neutral prompt set
-- ---------------------------------------------------------------------
alter table public.prompts add column if not exists is_neutral boolean;

create table if not exists public.neutral_exclusion_terms (
  property_id uuid not null references public.properties(id) on delete cascade,
  term        text not null,        -- case-insensitive substring; a prompt containing it is NOT neutral
  primary key (property_id, term)
);

-- a prompt is neutral unless it contains one of the property's exclusion terms.
-- Runs after every upload; to change the split, edit neutral_exclusion_terms.
create or replace function public.classify_neutral_prompts() returns void
language sql as $$
  update public.prompts p
     set is_neutral = not exists (
           select 1 from public.intents i
           join public.neutral_exclusion_terms t on t.property_id = i.property_id
           where i.id = p.intent_id and p.prompt_text ilike '%' || t.term || '%')
   where p.is_neutral is distinct from not exists (
           select 1 from public.intents i
           join public.neutral_exclusion_terms t on t.property_id = i.property_id
           where i.id = p.intent_id and p.prompt_text ilike '%' || t.term || '%');
$$;

-- ---------------------------------------------------------------------
-- Tracked competitor set
-- ---------------------------------------------------------------------
create table if not exists public.competitor_groups (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  name          text not null,          -- short label used in tables
  display_name  text,                   -- e.g. 'Elysium Manly (formerly Manly Pacific)'
  aliases       text[] not null default '{}',   -- exact names engines use; trailing * = starts with
  sort_order    int not null default 100,
  is_tracked    boolean not null default true,
  unique (property_id, name)
);

create or replace function public.name_matches(p_name text, p_aliases text[])
returns boolean language sql immutable as $$
  select exists (select 1 from unnest(p_aliases) a
                 where case when right(a, 1) = '*'
                            then lower(trim(p_name)) like lower(rtrim(a, '*')) || '%'
                            else lower(trim(p_name)) = lower(trim(a)) end);
$$;

-- ---------------------------------------------------------------------
-- Benchmarks (baseline, earlier benchmarks, report snapshots, targets)
-- ---------------------------------------------------------------------
create table if not exists public.benchmarks (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  label        text not null,            -- 'Pre-schema baseline', '13 Aug benchmark', 'Target'…
  kind         text not null default 'baseline' check (kind in ('baseline','benchmark','report','target')),
  as_of        date,
  prompt_set   text not null default 'full' check (prompt_set in ('full','neutral')),
  dimension    text not null default 'overall' check (dimension in ('overall','engine','intent','competitor')),
  dim_key      text not null default '',  -- engine name / intent name / competitor group name
  metric       text not null check (metric in ('visibility','detection','position','top3','sentiment')),
  value        numeric not null,
  is_derived   boolean not null default false,  -- back-calculated from a reported % movement
  note         text,
  unique (property_id, label, prompt_set, dimension, dim_key, metric)
);

-- ---------------------------------------------------------------------
-- Source categories for cited domains
-- ---------------------------------------------------------------------
create table if not exists public.source_categories (
  pattern   text primary key,     -- LIKE pattern on the domain, e.g. 'tripadvisor.%'
  category  text not null check (category in ('IHG / brand ecosystem','Editorial / PR','Venue guides',
                                               'OTA / reviews','Search & maps','Other')),
  priority  int not null default 100
);

delete from public.source_categories where pattern = '%.intercontinental.com';   -- earlier versions had it
insert into public.source_categories (pattern, category, priority) values
  ('ihg.com','IHG / brand ecosystem',10), ('%.ihg.com','IHG / brand ecosystem',10),
  ('ihgplc.com','IHG / brand ecosystem',10), ('intercontinental.com','IHG / brand ecosystem',11),
  -- other *.intercontinental.com sites are sister hotels: they fall through to 'Competitor sites'
  ('tagvenue.com','Venue guides',20), ('venuenow.com','Venue guides',20), ('wedlockers.com.au','Venue guides',20),
  ('hitched.com.au','Venue guides',20), ('easyweddings.com.au','Venue guides',20), ('venues.com.au','Venue guides',20),
  ('hirespace.com','Venue guides',20), ('cvent.com','Venue guides',20), ('%.cvent.com','Venue guides',20),
  ('timeout.com','Editorial / PR',30), ('broadsheet.com.au','Editorial / PR',30),
  ('concreteplayground.com','Editorial / PR',30), ('urbanlist.com','Editorial / PR',30),
  ('theurbanlist.com','Editorial / PR',30), ('goodfood.com.au','Editorial / PR',30),
  ('smh.com.au','Editorial / PR',30), ('news.com.au','Editorial / PR',30), ('traveller.com.au','Editorial / PR',30),
  ('escape.com.au','Editorial / PR',30), ('australiantraveller.com','Editorial / PR',30),
  ('hotelmagazine.co.nz','Editorial / PR',30), ('cntraveler.com','Editorial / PR',30),
  ('travelandleisure.com','Editorial / PR',30), ('lonelyplanet.com','Editorial / PR',30),
  ('sydney.com','Editorial / PR',30), ('visitnsw.com','Editorial / PR',30), ('forbes.com','Editorial / PR',30),
  ('gourmettraveller.com.au','Editorial / PR',30), ('delicious.com.au','Editorial / PR',30),
  ('booking.com','OTA / reviews',40), ('tripadvisor.%','OTA / reviews',40), ('%.tripadvisor.%','OTA / reviews',40),
  ('expedia.%','OTA / reviews',40), ('%.expedia.%','OTA / reviews',40), ('hotels.com','OTA / reviews',40),
  ('agoda.com','OTA / reviews',40), ('trip.com','OTA / reviews',40), ('wotif.com','OTA / reviews',40),
  ('trivago.%','OTA / reviews',40), ('kayak.%','OTA / reviews',40), ('yelp.%','OTA / reviews',40),
  ('google.com','Search & maps',50), ('%.google.com','Search & maps',50), ('%.googleusercontent.com','Search & maps',50),
  ('bing.com','Search & maps',50), ('%.bing.com','Search & maps',50), ('youtube.com','Search & maps',50)
on conflict (pattern) do nothing;

-- one category per domain for a property: owned > patterns > competitor site > other
create or replace view public.v_domain_category with (security_invoker = on) as
with d as (
  select e.property_id, e.domain,
         count(*) filter (where e.attributed_to = 'competitor') as for_competitors,
         count(*) filter (where e.attributed_to = 'own_brand')  as for_hotel
  from public.evidence e where e.domain is not null
  group by e.property_id, e.domain
)
select d.property_id, d.domain,
       case
         when exists (select 1 from public.properties p
                      where p.id = d.property_id
                        and exists (select 1 from unnest(p.own_domains) o
                                    where d.domain = o or d.domain like '%.' || o)
                        and d.domain not like '%ihg%')                 then 'Owned site'
         when sc.category is not null                                   then sc.category
         when d.for_competitors > d.for_hotel                           then 'Competitor sites'
         else 'Other'
       end as category
from d
left join lateral (select category from public.source_categories s
                   where d.domain like s.pattern order by priority limit 1) sc on true;

-- ---------------------------------------------------------------------
-- Report notes (commentary boxes)
-- ---------------------------------------------------------------------
create table if not exists public.report_notes (
  property_id  uuid not null references public.properties(id) on delete cascade,
  period_key   text not null,      -- e.g. '2026-08-20_2026-09-17'
  section      text not null,      -- 'monitor_next', 'good_news', …
  body         text not null,
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (property_id, period_key, section)
);

-- ---------------------------------------------------------------------
-- Per-answer scores
-- ---------------------------------------------------------------------
create or replace view public.v_answer_scores with (security_invoker = on) as
with own as (
  select mm.measurement_id, min(mm.rank) as rank,
         (array_agg(mm.sentiment order by mm.rank))[1] as sentiment
  from public.measurement_mentions mm where mm.is_own_brand
  group by mm.measurement_id
)
select f.measurement_id, f.property_id, f.intent_id, f.intent, f.prompt_id, f.engine, f.measured_at,
       (f.measured_at at time zone 'Australia/Sydney')::date as day,
       coalesce(pr.is_neutral, true) as is_neutral,
       -- Rankscale's view: its brand_found and brand_rank
       f.brand_found                                                   as found_rs,
       case when f.brand_found then f.own_brand_rank end               as rank_rs,
       case when f.brand_found then f.own_brand_sentiment end          as sentiment_rs,
       -- all confirmed hotel names (aliases)
       f.brand_found_any_alias                                         as found_any,
       case when f.brand_found_any_alias then least(f.own_brand_rank, own.rank) end as rank_any,
       case when f.brand_found_any_alias then coalesce(f.own_brand_sentiment, own.sentiment) end as sentiment_any
from public.v_measurements_flat f
join public.prompts pr on pr.id = f.prompt_id
left join own on own.measurement_id = f.measurement_id;

create or replace view public.v_competitor_answer_scores with (security_invoker = on) as
select a.measurement_id, a.property_id, a.intent, a.engine, a.day, a.is_neutral, a.measured_at,
       g.id as group_id, g.name as group_name, g.sort_order,
       min(mm.rank) as rank,
       (array_agg(mm.sentiment order by mm.rank))[1] as sentiment
from public.v_answer_scores a
join public.competitor_groups g on g.property_id = a.property_id and g.is_tracked
join public.measurement_mentions mm on mm.measurement_id = a.measurement_id
                                    and public.name_matches(mm.brand_name_raw, g.aliases)
group by a.measurement_id, a.property_id, a.intent, a.engine, a.day, a.is_neutral, a.measured_at,
         g.id, g.name, g.sort_order;

-- ---------------------------------------------------------------------
-- RLS for the new tables
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['neutral_exclusion_terms','competitor_groups','benchmarks','source_categories','report_notes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_authenticated_all on public.%I', t, t);
    execute format('create policy %I_authenticated_all on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;

-- =====================================================================
-- Seed: InterContinental Sydney Coogee Beach. Safe to call repeatedly; the
-- upload gateway calls it after each load, so order of setup doesn't matter.
-- =====================================================================
create or replace function public.seed_coogee_report() returns void
language plpgsql as $$
declare pid uuid;
begin
  select id into pid from public.properties where name = 'InterContinental Sydney Coogee Beach';
  if pid is null then
    raise notice 'Coogee property not found yet — it will be seeded automatically on the first upload';
    return;
  end if;

  -- the hotel's booking-engine and gift-voucher domains count as its own site
  update public.properties
     set own_domains = (select array_agg(distinct d) from unnest(own_domains || array[
           'coogeebeach-intercontinental.vouchercart.com','intercontinental-sydney-coogee-beach.h-rez.com']) d)
   where id = pid;

  -- neutral set = the 17 prompts without brand or location terms (the Aug report's definition)
  insert into public.neutral_exclusion_terms (property_id, term)
  select pid, t from unnest(array['Coogee','InterContinental','Rick Stein','Shutters','Èliva','Eliva',
                                  'Randwick','Allianz Stadium']) t
  on conflict do nothing;
  perform public.classify_neutral_prompts();

  -- tracked competitor set from the Aug 2026 report
  insert into public.competitor_groups (property_id, name, display_name, aliases, sort_order) values
    (pid, 'Elysium Manly', 'Elysium Manly (formerly Manly Pacific)',
     array['Elysium Manly','Manly Pacific','Manly Pacific Hotel','Manly Pacific Sydney','Manly Pacific Sydney MGallery*',
           'Novotel Sydney Manly Pacific','Beachside Manly Pacific'], 10),
    (pid, 'Pier One', 'Pier One Sydney Harbour',
     array['Pier One','Pier One Sydney Harbour*','Bridge Marquee at Pier One','Pier One Bridge Marquee'], 20),
    (pid, 'Langham', 'The Langham, Sydney',
     array['The Langham','The Langham Sydney','The Langham, Sydney','Langham Sydney','The Day Spa by Chuan at The Langham Sydney'], 30),
    (pid, 'InterCon Double Bay', 'InterContinental Sydney Double Bay',
     array['InterContinental Double Bay','InterContinental Sydney Double Bay*'], 40)
  on conflict (property_id, name) do update
    set display_name = excluded.display_name, aliases = excluded.aliases, sort_order = excluded.sort_order;

  -- benchmarks from the Aug 2026 report (31 Jul – 31 Aug). Baselines are back-calculated
  -- from the reported relative movement, so they're flagged is_derived.
  insert into public.benchmarks (property_id, label, kind, as_of, prompt_set, dimension, dim_key, metric, value, is_derived, note)
  select pid, v.label, v.kind, v.as_of::date, v.pset, v.dim, v.dkey, v.metric, v.val, v.derived, v.note
  from (values
    -- pre-schema baseline, full 22-prompt set
    ('Pre-schema baseline','baseline','2026-07-30','full','overall','','visibility',34.74,true,'40.47 reported as +16.5%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','overall','','detection',37.04,true,'42.34 reported as +14.3%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','overall','','position',2.13,true,'#2.03 reported as improved 4.5%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','overall','','sentiment',85.88,true,'88.8 reported as +3.4%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','engine','ChatGPT','visibility',64.15,true,'66.91, +4.3%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','engine','Gemini','visibility',47.17,true,'44.95, −4.7%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','engine','Claude','visibility',40.59,true,'38.68, −4.7%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','engine','Google AI Overview','visibility',38.14,true,'35.66, −6.5%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','engine','Perplexity','visibility',29.78,true,'33.50, +12.5%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','engine','Bing Copilot','visibility',30.26,true,'30.84, +1.9%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','intent','Dining-Led Discovery','visibility',54.95,true,'65.99, +20.1%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','intent','Luxury Coastal Stay','visibility',56.91,true,'63.74, +12.0%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','intent','Family Stays','visibility',31.18,true,'58.03, +86.1%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','intent','Wellness & Spa','visibility',40.16,true,'46.63, +16.1%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','intent','Business / Bleisure','visibility',30.31,true,'38.65, +27.5%'),
    ('Pre-schema baseline','baseline','2026-07-30','full','intent','Romance & Events','visibility',14.58,true,'15.62, +7.1%'),
    -- 13 Aug neutral benchmark
    ('13 Aug benchmark','benchmark','2026-08-13','neutral','overall','','visibility',40.6,false,null),
    ('13 Aug benchmark','benchmark','2026-08-13','neutral','overall','','detection',42.8,false,null),
    ('13 Aug benchmark','benchmark','2026-08-13','neutral','overall','','position',1.8,false,null),
    ('13 Aug benchmark','benchmark','2026-08-13','neutral','overall','','top3',38.4,false,null),
    ('13 Aug benchmark','benchmark','2026-08-13','neutral','overall','','sentiment',90.6,false,null),
    -- Aug report snapshot (what the client saw)
    ('Aug 2026 report','report','2026-08-31','full','overall','','visibility',40.47,false,null),
    ('Aug 2026 report','report','2026-08-31','full','overall','','detection',42.34,false,null),
    ('Aug 2026 report','report','2026-08-31','full','overall','','position',2.03,false,null),
    ('Aug 2026 report','report','2026-08-31','full','overall','','sentiment',88.8,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','overall','','visibility',27.93,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','overall','','detection',30.99,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','overall','','position',2.45,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','overall','','top3',25.73,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','overall','','sentiment',88.0,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','competitor','Elysium Manly','visibility',10.28,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','competitor','Pier One','visibility',17.8,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','competitor','Langham','visibility',9.58,false,null),
    ('Aug 2026 report','report','2026-08-31','neutral','competitor','InterCon Double Bay','visibility',4.96,false,null)
  ) as v(label, kind, as_of, pset, dim, dkey, metric, val, derived, note)
  on conflict (property_id, label, prompt_set, dimension, dim_key, metric) do update
    set value = excluded.value, as_of = excluded.as_of, is_derived = excluded.is_derived, note = excluded.note;
end $$;

-- runs now if the data is already loaded; the upload gateway also calls it after every load
select public.seed_coogee_report();
