-- =====================================================================
-- Dashboard views (Workflow 1). Run after 01_schema.sql; safe to re-run.
-- The FastAPI dashboard endpoints read only from these views, so the UI
-- never needs to know how the tables join.
-- security_invoker = on → the views respect the tables' RLS policies.
-- =====================================================================

-- one row per engine answer, with everything the dashboard filters on
create or replace view public.v_measurements_flat with (security_invoker = on) as
select m.id                         as measurement_id,
       p.id                         as property_id,
       p.name                       as property_name,
       i.id                         as intent_id,
       i.name                       as intent,
       pr.id                        as prompt_id,
       pr.prompt_text,
       e.name                       as engine,
       m.measured_at,
       date_trunc('week', m.measured_at)::date as week_start,
       m.brand_found,
       coalesce(m.brand_found_any_alias, m.brand_found) as brand_found_any_alias,
       m.own_brand_rank,
       m.own_brand_sentiment,
       m.brands_total,
       m.visibility_score_30d,
       m.used_web_search,
       m.import_batch
from public.measurements m
join public.prompts pr    on pr.id = m.prompt_id
join public.intents i     on i.id = pr.intent_id
join public.properties p  on p.id = i.property_id
join public.engines e     on e.id = m.engine_id;

-- headline numbers per property
create or replace view public.v_kpis with (security_invoker = on) as
select property_id, property_name,
       count(*)                                                    as answers,
       count(distinct prompt_id)                                   as prompts,
       count(distinct engine)                                      as engines,
       min(measured_at)::date                                      as first_measured,
       max(measured_at)::date                                      as last_measured,
       round(avg(brand_found::int), 3)                             as found_rate_rankscale,
       round(avg(brand_found_any_alias::int), 3)                   as found_rate_any_alias,
       round(avg(own_brand_rank) filter (where brand_found_any_alias), 2)      as avg_rank_when_found,
       round(avg(own_brand_sentiment) filter (where brand_found_any_alias), 3) as avg_sentiment_when_found
from public.v_measurements_flat
group by property_id, property_name;

-- intent × engine visibility grid (the heatmap)
create or replace view public.v_visibility_intent_engine with (security_invoker = on) as
select property_id, intent, engine,
       count(*)                                        as answers,
       count(*) filter (where brand_found)             as found_rankscale,
       count(*) filter (where brand_found_any_alias)   as found_any_alias,
       round(avg(brand_found_any_alias::int), 3)       as found_rate,
       round(avg(own_brand_rank) filter (where brand_found_any_alias), 2) as avg_rank_when_found
from public.v_measurements_flat
group by property_id, intent, engine;

-- weekly trend, per intent
create or replace view public.v_visibility_weekly with (security_invoker = on) as
select property_id, week_start, intent,
       count(*)                                        as answers,
       round(avg(brand_found_any_alias::int), 3)       as found_rate,
       round(avg(brand_found::int), 3)                 as found_rate_rankscale
from public.v_measurements_flat
group by property_id, week_start, intent;

-- which competitors take the answers, per intent
create or replace view public.v_competitor_share with (security_invoker = on) as
with totals as (
  select property_id, intent, count(*) as answers
  from public.v_measurements_flat group by property_id, intent
)
select f.property_id, f.intent, c.name as competitor,
       count(distinct f.measurement_id)                              as answers_mentioning,
       round(count(distinct f.measurement_id)::numeric / t.answers, 3) as share_of_answers,
       round(avg(mm.rank), 2)                                        as avg_rank,
       count(distinct f.measurement_id) filter (where mm.rank = 1)   as times_ranked_first,
       round(avg(mm.sentiment), 3)                                   as avg_sentiment
from public.v_measurements_flat f
join public.measurement_mentions mm on mm.measurement_id = f.measurement_id and not mm.is_own_brand
join public.competitors c           on c.id = mm.competitor_id
join totals t on t.property_id = f.property_id and t.intent = f.intent
group by f.property_id, f.intent, c.name, t.answers;

-- the sources engines cite, split by who they were cited for
create or replace view public.v_citation_domains with (security_invoker = on) as
select e.property_id, e.domain, e.attributed_to,
       count(*)                                    as citations,
       count(distinct e.measurement_id)            as answers,
       count(distinct f.intent)                    as intents,
       array_agg(distinct f.intent)                as intent_list,
       round(avg(e.confidence_score), 2)           as avg_confidence
from public.evidence e
join public.v_measurements_flat f on f.measurement_id = e.measurement_id
where e.domain is not null
group by e.property_id, e.domain, e.attributed_to;

-- one row per prompt: how the hotel does on it overall
create or replace view public.v_prompt_scorecard with (security_invoker = on) as
with top_comp as (
  select f.prompt_id, c.name, count(*) as n,
         row_number() over (partition by f.prompt_id order by count(*) desc, c.name) as rn
  from public.v_measurements_flat f
  join public.measurement_mentions mm on mm.measurement_id = f.measurement_id and not mm.is_own_brand
  join public.competitors c on c.id = mm.competitor_id
  where mm.rank <= 3
  group by f.prompt_id, c.name
)
select f.property_id, f.prompt_id, f.intent, f.prompt_text,
       count(*)                                        as answers,
       round(avg(f.brand_found_any_alias::int), 3)     as found_rate,
       min(f.own_brand_rank)                           as best_rank,
       round(avg(f.own_brand_rank) filter (where f.brand_found_any_alias), 2) as avg_rank_when_found,
       max(f.measured_at)::date                        as last_measured,
       (select tc.name from top_comp tc where tc.prompt_id = f.prompt_id and tc.rn = 1) as top_competitor,
       (select count(*) from public.recommendations r
          join public.measurements m on m.id = r.measurement_id
         where m.prompt_id = f.prompt_id)              as recommendations
from public.v_measurements_flat f
group by f.property_id, f.prompt_id, f.intent, f.prompt_text;

-- review queue: diagnoses and their recommendations, newest first
create or replace view public.v_recommendation_queue with (security_invoker = on) as
select r.id as recommendation_id, r.title, r.detail, r.action_type, r.priority, r.status,
       r.created_at, d.id as diagnosis_id, d.diagnosis_type, d.severity, d.root_cause,
       d.confidence_score as diagnosis_confidence, d.status as diagnosis_status, d.generated_by,
       f.property_id, f.intent, f.prompt_text, f.engine, f.measured_at, f.measurement_id,
       (select count(*) from public.human_feedback hf where hf.recommendation_id = r.id) as feedback_count
from public.recommendations r
left join public.diagnoses d on d.id = r.diagnosis_id
join public.v_measurements_flat f on f.measurement_id = r.measurement_id;
