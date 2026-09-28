-- =====================================================================
-- Load stg_rankscale_export into the V1 tables.
-- Safe to re-run: existing rows are skipped or updated, never duplicated.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. The property and every name that counts as "us".
--    Anything not in aliases or ignored_names is treated as a competitor.
-- ---------------------------------------------------------------------
insert into public.properties (name, brand_group, location, website_url, aliases, ignored_names)
values (
  'InterContinental Sydney Coogee Beach', 'IHG', 'Coogee, Sydney NSW',
  'https://coogeebeach.intercontinental.com',
  array[
    -- 1. Confirmed by supervisor (24 Sep 2026): names in AI answers that mean this hotel
    'InterContinental Sydney Coogee Beach','InterContinental Coogee Beach',
    'InterContinental Sydney Coogee Beach by IHG','InterContinental Coogee',
    'Intercontinental Sydney Coogee Beach',
    'InterContinental Sydney Coogee Beach - Shutters Restaurant & Bar',
    'Shutters Restaurant & Bar','Shutters Restaurant and Bar','Shutters Restaurant',
    'Shutters','Shutters Coogee','Shutters Coogee Beach',
    'Rick Stein at Coogee Beach','Rick Stein at Coogee','Rick Stein','Rick Stein''s',
    'Rick Stein''s Coogee Beach',
    'Èliva Spa','Èliva Spa & Wellness','Èliva','Eliva Spa','Èliva Wellness',
    'Eliva Spa & Wellness','Èliva Coogee Beach','Èliva Spa - InterContinental Coogee Beach',
    'Èliva Spa Coogee Beach',
    'Crowne Plaza Sydney Coogee Beach','Crowne Plaza Coogee Beach','Crowne Plaza Coogee',
    -- 2. Also in Rankscale → Brand Settings (a trailing * means "starts with")
    'InterContinental Sydney Coogee Beach*',
    'InterContinental Sydney Coogee',
    'Shutters at InterContinental Sydney Coogee Beach',
    'Rick Stein at InterContinental Sydney Coogee Beach',
    'Rick Stein''s at InterContinental Sydney Coogee Beach'
  ],
  -- neither us nor a competitor: skipped when loading mentions and competitors
  array['Club InterContinental'])
on conflict (name) do update
  set aliases = excluded.aliases, ignored_names = excluded.ignored_names;

update public.properties
   set own_domains = array['coogeebeach.intercontinental.com','ihg.com','ihgplc.com']
 where name = 'InterContinental Sydney Coogee Beach' and own_domains = '{}';

-- helper: is this brand name one of the property's own names?
-- Case-insensitive; an alias ending in * matches any name that starts with it.
create or replace function public.is_own_brand(p_property_id uuid, p_name text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.properties p, unnest(p.aliases || p.name) a
    where p.id = p_property_id
      and case when right(a, 1) = '*'
               then lower(trim(p_name)) like lower(rtrim(a, '*')) || '%'
               else lower(trim(p_name)) = lower(trim(a)) end);
$$;

-- helper: is this a name we deliberately ignore (neither us nor a competitor)?
create or replace function public.is_ignored_name(p_property_id uuid, p_name text)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.properties p, unnest(p.ignored_names) a
    where p.id = p_property_id and lower(trim(p_name)) = lower(trim(a)));
$$;

-- helper: 'a; b; c' -> {a,b,c}
create or replace function public.split_keywords(p text)
returns text[] language sql immutable as $$
  select nullif(array(select trim(x) from unnest(string_to_array(p, ';')) x where trim(x) <> ''), '{}');
$$;

-- staging rows matched to the property via brand_reference
create or replace view public.stg_rankscale_matched as
select s.*, p.id as property_id
from public.stg_rankscale_export s
join public.properties p
  on public.is_own_brand(p.id, s.brand_reference);

-- any engine code we haven't seen before gets added to the lookup
insert into public.engines (name, rankscale_code)
select distinct s.ai_engine, s.ai_engine
from public.stg_rankscale_export s
where nullif(trim(s.ai_engine), '') is not null
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 1. Intents (Rankscale topic_name)
-- ---------------------------------------------------------------------
insert into public.intents (property_id, name)
select distinct property_id, trim(topic_name)
from public.stg_rankscale_matched
where nullif(trim(topic_name), '') is not null
on conflict (property_id, name) do nothing;

-- ---------------------------------------------------------------------
-- 2. Prompts
-- ---------------------------------------------------------------------
insert into public.prompts (intent_id, prompt_text, source, related_prompts)
select distinct on (i.id, trim(s.query))
       i.id, trim(s.query), 'rankscale',
       -- related prompts are comma-joined questions; split where a new one starts
       nullif(array(select trim(x) from regexp_split_to_table(s.related_prompts, ',(?=[A-Z"])') x
                    where trim(x) <> ''), '{}')
from public.stg_rankscale_matched s
join public.intents i on i.property_id = s.property_id and i.name = trim(s.topic_name)
order by i.id, trim(s.query), s."timestamp" desc
on conflict (intent_id, prompt_text) do update
  set related_prompts = coalesce(excluded.related_prompts, prompts.related_prompts),
      status = 'tracked';   -- an agent-generated prompt is now being measured by Rankscale

-- ---------------------------------------------------------------------
-- 3. Measurements. Rankscale writes one row per own-brand name it spots, so
--    one engine answer can appear 2-3 times; keep the best-ranked row.
-- ---------------------------------------------------------------------
insert into public.measurements (
  prompt_id, engine_id, engine_model, measured_at, brand_found,
  own_brand_rank, own_brand_name_mentioned, own_brand_sentiment, own_brand_sentiment_reason,
  brands_total, visibility_score_latest, visibility_score_24h, visibility_score_7d, visibility_score_30d,
  used_web_search, ai_overview_present, web_search_queries, response_text, source, import_batch)
select distinct on (pr.id, e.id, s."timestamp"::timestamptz)
  pr.id, e.id, nullif(s.chatgpt_model, ''), s."timestamp"::timestamptz,
  coalesce(nullif(s.brand_found, '')::boolean, false),
  nullif(s.brand_rank, '')::int, nullif(s.brand_name_mentioned, ''),
  nullif(s.sentiment, '')::numeric, nullif(s.sentiment_reason, ''),
  nullif(s.brands_total, '')::int,
  nullif(s.visibility_score_latest, '')::numeric, nullif(s.visibility_score_24h, '')::numeric,
  nullif(s.visibility_score_7d, '')::numeric,     nullif(s.visibility_score_30d, '')::numeric,
  nullif(s.chatgpt_websearch, '')::boolean, nullif(s.ai_overview, '')::boolean,
  nullif(s.web_search_queries, ''), nullif(s.result_text, ''),
  'rankscale',
  -- the import gateway sets geo.import_batch to its batch id; manual runs get a date label
  coalesce(nullif(current_setting('geo.import_batch', true), ''), 'rankscale:' || to_char(now(), 'YYYY-MM-DD'))
from public.stg_rankscale_matched s
join public.intents i  on i.property_id = s.property_id and i.name = trim(s.topic_name)
join public.prompts pr on pr.intent_id = i.id and pr.prompt_text = trim(s.query)
join public.engines e  on e.rankscale_code = s.ai_engine
order by pr.id, e.id, s."timestamp"::timestamptz, nullif(s.brand_rank, '')::int nulls last
on conflict (prompt_id, engine_id, measured_at) do nothing;

-- view: each staging row with its measurement id (used by the steps below)
create or replace view public.stg_rankscale_measured as
select s.*, m.id as measurement_id, m.measured_at
from public.stg_rankscale_matched s
join public.intents i      on i.property_id = s.property_id and i.name = trim(s.topic_name)
join public.prompts pr     on pr.intent_id = i.id and pr.prompt_text = trim(s.query)
join public.engines e      on e.rankscale_code = s.ai_engine
join public.measurements m on m.prompt_id = pr.id and m.engine_id = e.id
                          and m.measured_at = s."timestamp"::timestamptz;

-- ---------------------------------------------------------------------
-- 4. Competitors: every ranked brand that isn't one of our own names
-- ---------------------------------------------------------------------
insert into public.competitors (name)
select distinct trim(v.name)
from public.stg_rankscale_measured s
cross join lateral (values (s.rank1_brandname), (s.rank2_brandname), (s.rank3_brandname), (s.rank4_brandname), (s.rank5_brandname), (s.rank6_brandname), (s.rank7_brandname), (s.rank8_brandname), (s.rank9_brandname), (s.rank10_brandname), (s.rank11_brandname), (s.rank12_brandname), (s.rank13_brandname), (s.rank14_brandname), (s.rank15_brandname)) v(name)
where nullif(trim(v.name), '') is not null
  and not public.is_own_brand(s.property_id, v.name)
  and not public.is_ignored_name(s.property_id, v.name)
on conflict (name) do nothing;

insert into public.property_relationships (property_id, competitor_id, relationship_type, first_seen_at)
select s.property_id, c.id, 'observed_competitor', min(s.measured_at)
from public.stg_rankscale_measured s
cross join lateral (values (s.rank1_brandname), (s.rank2_brandname), (s.rank3_brandname), (s.rank4_brandname), (s.rank5_brandname), (s.rank6_brandname), (s.rank7_brandname), (s.rank8_brandname), (s.rank9_brandname), (s.rank10_brandname), (s.rank11_brandname), (s.rank12_brandname), (s.rank13_brandname), (s.rank14_brandname), (s.rank15_brandname)) v(name)
join public.competitors c on c.name = trim(v.name)
group by s.property_id, c.id
on conflict (property_id, competitor_id, relationship_type) do update
  set first_seen_at = least(property_relationships.first_seen_at, excluded.first_seen_at);

-- ---------------------------------------------------------------------
-- 5. Mentions: the full ranked list from each answer (rank1 … rank15)
-- ---------------------------------------------------------------------
insert into public.measurement_mentions (
  measurement_id, rank, brand_name_raw, is_own_brand, competitor_id,
  sentiment, sentiment_reason, positive_keywords, neutral_keywords, negative_keywords)
select distinct on (s.measurement_id, v.rnk)
  s.measurement_id, v.rnk, trim(v.name),
  public.is_own_brand(s.property_id, v.name),
  c.id,
  nullif(v.sent, '')::numeric, nullif(v.reason, ''),
  public.split_keywords(v.pos), public.split_keywords(v.neu), public.split_keywords(v.neg)
from public.stg_rankscale_measured s
cross join lateral (values
        (1, s.rank1_brandname, s.rank1_sentiment, s.rank1_sentiment_reason, s.rank1_positive_keywords, s.rank1_neutral_keywords, s.rank1_negative_keywords),
        (2, s.rank2_brandname, s.rank2_sentiment, s.rank2_sentiment_reason, s.rank2_positive_keywords, s.rank2_neutral_keywords, s.rank2_negative_keywords),
        (3, s.rank3_brandname, s.rank3_sentiment, s.rank3_sentiment_reason, s.rank3_positive_keywords, s.rank3_neutral_keywords, s.rank3_negative_keywords),
        (4, s.rank4_brandname, s.rank4_sentiment, s.rank4_sentiment_reason, s.rank4_positive_keywords, s.rank4_neutral_keywords, s.rank4_negative_keywords),
        (5, s.rank5_brandname, s.rank5_sentiment, s.rank5_sentiment_reason, s.rank5_positive_keywords, s.rank5_neutral_keywords, s.rank5_negative_keywords),
        (6, s.rank6_brandname, s.rank6_sentiment, s.rank6_sentiment_reason, s.rank6_positive_keywords, s.rank6_neutral_keywords, s.rank6_negative_keywords),
        (7, s.rank7_brandname, s.rank7_sentiment, s.rank7_sentiment_reason, s.rank7_positive_keywords, s.rank7_neutral_keywords, s.rank7_negative_keywords),
        (8, s.rank8_brandname, s.rank8_sentiment, s.rank8_sentiment_reason, s.rank8_positive_keywords, s.rank8_neutral_keywords, s.rank8_negative_keywords),
        (9, s.rank9_brandname, s.rank9_sentiment, s.rank9_sentiment_reason, s.rank9_positive_keywords, s.rank9_neutral_keywords, s.rank9_negative_keywords),
        (10, s.rank10_brandname, s.rank10_sentiment, s.rank10_sentiment_reason, s.rank10_positive_keywords, s.rank10_neutral_keywords, s.rank10_negative_keywords),
        (11, s.rank11_brandname, s.rank11_sentiment, s.rank11_sentiment_reason, s.rank11_positive_keywords, s.rank11_neutral_keywords, s.rank11_negative_keywords),
        (12, s.rank12_brandname, s.rank12_sentiment, s.rank12_sentiment_reason, s.rank12_positive_keywords, s.rank12_neutral_keywords, s.rank12_negative_keywords),
        (13, s.rank13_brandname, s.rank13_sentiment, s.rank13_sentiment_reason, s.rank13_positive_keywords, s.rank13_neutral_keywords, s.rank13_negative_keywords),
        (14, s.rank14_brandname, s.rank14_sentiment, s.rank14_sentiment_reason, s.rank14_positive_keywords, s.rank14_neutral_keywords, s.rank14_negative_keywords),
        (15, s.rank15_brandname, s.rank15_sentiment, s.rank15_sentiment_reason, s.rank15_positive_keywords, s.rank15_neutral_keywords, s.rank15_negative_keywords)
     ) v(rnk, name, sent, reason, pos, neu, neg)
left join public.competitors c
  on c.name = trim(v.name) and not public.is_own_brand(s.property_id, v.name)
where nullif(trim(v.name), '') is not null
  and not public.is_ignored_name(s.property_id, v.name)
order by s.measurement_id, v.rnk
on conflict (measurement_id, rank) do nothing;

-- if the alias / ignored lists changed since the last load, fix earlier mentions
delete from public.measurement_mentions mm
using public.measurements m, public.prompts pr, public.intents i
where m.id = mm.measurement_id and pr.id = m.prompt_id and i.id = pr.intent_id
  and public.is_ignored_name(i.property_id, mm.brand_name_raw);

update public.measurement_mentions mm
set is_own_brand = true, competitor_id = null
from public.measurements m, public.prompts pr, public.intents i
where m.id = mm.measurement_id and pr.id = m.prompt_id and i.id = pr.intent_id
  and not mm.is_own_brand and public.is_own_brand(i.property_id, mm.brand_name_raw);

-- flag answers that mention us under ANY alias (Rankscale's brand_found only
-- knows the names set up in Rankscale, so it can miss e.g. Crowne Plaza / Èliva)
update public.measurements m
set brand_found_any_alias = m.brand_found or exists (
      select 1 from public.measurement_mentions mm
      where mm.measurement_id = m.id and mm.is_own_brand)
where m.brand_found_any_alias is distinct from (m.brand_found or exists (
      select 1 from public.measurement_mentions mm
      where mm.measurement_id = m.id and mm.is_own_brand));

-- ---------------------------------------------------------------------
-- 6. Evidence from citations, with confidence metadata
--    0.80 = URL the engine cited and Rankscale tied to a specific brand
--    0.50 = URL cited in the answer but not tied to any brand
-- ---------------------------------------------------------------------
with cites as (
  -- own-brand citations
  select s.property_id, s.measurement_id, s.measured_at, null::uuid as competitor_id,
         'own_brand' as attributed_to, s.brand_citations as urls, 0.80 as score,
         'Cited by the AI engine and attributed to our property by Rankscale; not manually checked' as basis
  from public.stg_rankscale_measured s
  union all
  -- competitor citations (rank1 … rank15)
  select s.property_id, s.measurement_id, s.measured_at, c.id, 'competitor', v.urls, 0.80,
         'Cited by the AI engine and attributed to this competitor by Rankscale; not manually checked'
  from public.stg_rankscale_measured s
  cross join lateral (values
        (s.rank1_brandname, s.rank1_citations),
        (s.rank2_brandname, s.rank2_citations),
        (s.rank3_brandname, s.rank3_citations),
        (s.rank4_brandname, s.rank4_citations),
        (s.rank5_brandname, s.rank5_citations),
        (s.rank6_brandname, s.rank6_citations),
        (s.rank7_brandname, s.rank7_citations),
        (s.rank8_brandname, s.rank8_citations),
        (s.rank9_brandname, s.rank9_citations),
        (s.rank10_brandname, s.rank10_citations),
        (s.rank11_brandname, s.rank11_citations),
        (s.rank12_brandname, s.rank12_citations),
        (s.rank13_brandname, s.rank13_citations),
        (s.rank14_brandname, s.rank14_citations),
        (s.rank15_brandname, s.rank15_citations)
     ) v(name, urls)
  join public.competitors c on c.name = trim(v.name)
  union all
  -- everything else the answer cited
  select s.property_id, s.measurement_id, s.measured_at, null, 'unattributed', s.other_citations, 0.50,
         'Cited in the AI answer but not linked to a specific brand by Rankscale'
  from public.stg_rankscale_measured s
)
insert into public.evidence (
  property_id, measurement_id, competitor_id, evidence_type, attributed_to, url, domain,
  confidence_score, confidence_basis, captured_at)
select c.property_id, c.measurement_id, c.competitor_id, 'ai_citation', c.attributed_to,
       trim(u.url), substring(trim(u.url) from '^https?://(?:www\.)?([^/?#]+)'),
       c.score, c.basis, c.measured_at
from cites c
cross join lateral regexp_split_to_table(c.urls, ',(?=https?://)') u(url)
where nullif(trim(c.urls), '') is not null and trim(u.url) ~ '^https?://'
on conflict (measurement_id, url, attributed_to, competitor_id) do nothing;

-- ---------------------------------------------------------------------
-- 7. Intelligence: visibility roll-up per intent × engine (and per intent overall)
-- ---------------------------------------------------------------------
with base as (
  select i.property_id, i.id as intent_id, i.name as intent_name, e.name as engine_name, m.*
  from public.measurements m
  join public.engines e  on e.id = m.engine_id
  join public.prompts pr on pr.id = m.prompt_id
  join public.intents i  on i.id = pr.intent_id
),
grouped as (
  select property_id, intent_id, intent_name, engine_id, max(engine_name) as engine_name,
         min(measured_at)::date as period_start, max(measured_at)::date as period_end,
         count(*) as answers,
         count(*) filter (where brand_found) as answers_with_brand,
         round(avg(own_brand_rank) filter (where brand_found), 2) as avg_rank_when_found,
         round(avg(own_brand_sentiment) filter (where brand_found), 3) as avg_sentiment_when_found
  from base
  group by grouping sets ((property_id, intent_id, intent_name, engine_id),
                          (property_id, intent_id, intent_name))
),
top_comp as (
  select b.intent_id, b.engine_id, c.name, count(*) as n,
         row_number() over (partition by b.intent_id, b.engine_id order by count(*) desc, c.name) as rn
  from base b
  join public.measurement_mentions mm on mm.measurement_id = b.id and not mm.is_own_brand
  join public.competitors c on c.id = mm.competitor_id
  group by grouping sets ((b.intent_id, b.engine_id, c.name), (b.intent_id, c.name))
)
insert into public.intelligence (property_id, intent_id, engine_id, period_start, period_end,
                                 insight_type, title, summary, metrics, generated_by)
select g.property_id, g.intent_id, g.engine_id, g.period_start, g.period_end,
       case when g.answers_with_brand::numeric / g.answers < 0.25 then 'visibility_gap'
            else 'visibility_summary' end,
       g.intent_name || ' · ' || coalesce(g.engine_name, 'all engines') || ': brand found in '
         || g.answers_with_brand || ' of ' || g.answers || ' answers',
       'Share of AI answers mentioning the property for this intent, '
         || to_char(g.period_start, 'DD Mon') || '–' || to_char(g.period_end, 'DD Mon YYYY') || '.',
       jsonb_build_object(
         'answers', g.answers,
         'answers_with_brand', g.answers_with_brand,
         'brand_found_rate', round(g.answers_with_brand::numeric / g.answers, 3),
         'avg_rank_when_found', g.avg_rank_when_found,
         'avg_sentiment_when_found', g.avg_sentiment_when_found,
         'top_competitors', (select jsonb_agg(jsonb_build_object('name', t.name, 'mentions', t.n) order by t.rn)
                             from top_comp t
                             where t.intent_id = g.intent_id and t.engine_id is not distinct from g.engine_id
                               and t.rn <= 3)),
       'sql_rollup'
from grouped g
on conflict (property_id, intent_id, engine_id, insight_type, period_start, period_end)
do update set title = excluded.title, summary = excluded.summary, metrics = excluded.metrics;
