-- =====================================================================
-- GEO Automation Platform — V1 database schema (Supabase / Postgres 15+)
-- Run once in the Supabase SQL Editor. Order: 00 → 01 → 02 → import CSV → 03 → 04 → 05.
--
-- Relationship map (all keys are UUIDs unless noted):
--
--   properties ─┬─< property_relationships >── competitors
--               ├─< intents ─< prompts ─< measurements >── engines
--                                        measurements ─┬─< measurement_mentions >── competitors
--               │                                       ├─< evidence
--               │                                       ├─< diagnoses ─< recommendations
--               │                                       └─< recommendations   (one measurement → many)
--               └─< intelligence ─< diagnoses
--   diagnoses >─< evidence            (via diagnosis_evidence)
--   human_feedback  → one of: recommendation | diagnosis | evidence | measurement
--   activity_history ← written automatically by triggers
-- =====================================================================

-- gen_random_uuid() is built into Postgres 13+, so no extension is needed.

-- ---------------------------------------------------------------------
-- 1. Properties (the hotels we track) and their competitive set
-- ---------------------------------------------------------------------
create table if not exists public.properties (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  brand_group   text,
  location      text,
  website_url   text,
  -- every name AI engines use for this property or its on-site outlets;
  -- used to tell "our brand" apart from competitors in engine answers
  aliases       text[] not null default '{}',
  -- names engines mention that are neither us nor a competitor
  -- (e.g. 'Club InterContinental', a lounge found in every InterContinental)
  ignored_names text[] not null default '{}',
  created_at    timestamptz not null default now()
);
-- for databases created before this column existed
alter table public.properties add column if not exists ignored_names text[] not null default '{}';
-- domains that count as the hotel's own site (used by agents and the evidence comparison)
alter table public.properties add column if not exists own_domains text[] not null default '{}';

create table if not exists public.competitors (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,      -- name exactly as the AI engine returned it
  website_domain  text,
  category        text check (category in ('hotel','restaurant','venue','spa','other')),
  created_at      timestamptz not null default now()
);

create table if not exists public.property_relationships (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null references public.properties(id) on delete cascade,
  competitor_id      uuid not null references public.competitors(id) on delete cascade,
  relationship_type  text not null default 'observed_competitor'
                     check (relationship_type in ('tracked_competitor','observed_competitor','sister_property','other')),
  is_tracked         boolean not null default false,  -- true = in the agreed competitive set
  first_seen_at      timestamptz,
  notes              text,
  created_at         timestamptz not null default now(),
  unique (property_id, competitor_id, relationship_type)
);

-- ---------------------------------------------------------------------
-- 2. AI engines (lookup)
-- ---------------------------------------------------------------------
create table if not exists public.engines (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,          -- display name
  rankscale_code  text not null unique,          -- value in Rankscale's ai_engine column
  created_at      timestamptz not null default now()
);

insert into public.engines (name, rankscale_code) values
  ('ChatGPT',            'chatgpt_gui'),
  ('Gemini',             'google_gemini_gui'),
  ('Google AI Overview', 'google_ai_overview'),
  ('Perplexity',         'perplexity_gui'),
  ('Bing Copilot',       'bing_copilot_gui'),
  ('Claude',             'anthropic_claude_4_5_haiku')
on conflict (rankscale_code) do nothing;

-- ---------------------------------------------------------------------
-- 3. Intents → prompts
-- ---------------------------------------------------------------------
create table if not exists public.intents (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references public.properties(id) on delete cascade,
  name         text not null,                 -- Rankscale "topic_name"
  description  text,
  created_at   timestamptz not null default now(),
  unique (property_id, name)
);

create table if not exists public.prompts (
  id               uuid primary key default gen_random_uuid(),
  intent_id        uuid not null references public.intents(id) on delete cascade,
  prompt_text      text not null,
  source           text not null default 'rankscale'
                   check (source in ('rankscale','prompt_agent','manual')),
  related_prompts  text[],
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (intent_id, prompt_text)
);

-- prompt-generation agents (upstream workflow): each run, and the extra
-- fields a generated prompt carries before Rankscale starts tracking it
create table if not exists public.prompt_generation_runs (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  model         text,
  inputs        jsonb not null default '{}',   -- what the agents were given
  intent_map    jsonb,                          -- agent 1 output
  summary       jsonb,                          -- counts, rejected prompts, etc.
  created_by    text,
  created_at    timestamptz not null default now()
);

alter table public.prompts add column if not exists status text not null default 'tracked'
  check (status in ('candidate','approved','rejected','exported','tracked'));
alter table public.prompts add column if not exists generation_run_id uuid
  references public.prompt_generation_runs(id) on delete set null;
alter table public.prompts add column if not exists prompt_type text;      -- unbranded / occasion / comparison / branded
alter table public.prompts add column if not exists persona text;
alter table public.prompts add column if not exists rationale text;
alter table public.prompts add column if not exists quality_score numeric(3,2);

-- one row per CSV upload through the import gateway
create table if not exists public.import_batches (
  id              uuid primary key default gen_random_uuid(),
  filename        text,
  uploaded_by     text,
  status          text not null default 'validated'
                  check (status in ('validated','loaded','rejected','failed')),
  rows_in_file    integer,
  rows_valid      integer,
  rows_rejected   integer,
  measurements_added integer,
  mentions_added     integer,
  evidence_added     integer,
  report          jsonb not null default '{}',   -- validation errors and warnings
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. Measurements: one row = one AI engine answer to one prompt at one time
-- ---------------------------------------------------------------------
create table if not exists public.measurements (
  id                          uuid primary key default gen_random_uuid(),
  prompt_id                   uuid not null references public.prompts(id) on delete cascade,
  engine_id                   uuid not null references public.engines(id),
  engine_model                text,            -- e.g. gpt-5-6
  measured_at                 timestamptz not null,
  brand_found                 boolean not null,  -- Rankscale's verdict, unchanged
  brand_found_any_alias       boolean,           -- true if ANY of our aliases is in the answer
                                                 -- (catches names Rankscale isn't set up for)
  own_brand_rank              integer,          -- best (lowest) rank of any own-brand alias
  own_brand_name_mentioned    text,
  own_brand_sentiment         numeric(4,3),
  own_brand_sentiment_reason  text,
  brands_total                integer,
  visibility_score_latest     numeric(6,2),
  visibility_score_24h        numeric(6,2),
  visibility_score_7d         numeric(6,2),
  visibility_score_30d        numeric(6,2),
  used_web_search             boolean,
  ai_overview_present         boolean,
  web_search_queries          text,
  response_text               text,
  source                      text not null default 'rankscale',
  import_batch                text,
  created_at                  timestamptz not null default now(),
  unique (prompt_id, engine_id, measured_at)
);
-- for databases created before this column existed
alter table public.measurements add column if not exists brand_found_any_alias boolean;
create index if not exists measurements_measured_at_idx on public.measurements (measured_at);
create index if not exists measurements_engine_idx      on public.measurements (engine_id);

-- every brand an engine ranked in its answer (own brand included, flagged)
create table if not exists public.measurement_mentions (
  id                 uuid primary key default gen_random_uuid(),
  measurement_id     uuid not null references public.measurements(id) on delete cascade,
  rank               integer not null check (rank between 1 and 50),
  brand_name_raw     text not null,
  is_own_brand       boolean not null default false,
  competitor_id      uuid references public.competitors(id),   -- null when is_own_brand
  sentiment          numeric(4,3),
  sentiment_reason   text,
  positive_keywords  text[],
  neutral_keywords   text[],
  negative_keywords  text[],
  unique (measurement_id, rank),
  check (is_own_brand or competitor_id is not null)
);
create index if not exists mentions_competitor_idx on public.measurement_mentions (competitor_id);

-- ---------------------------------------------------------------------
-- 5. Evidence, with confidence metadata
-- ---------------------------------------------------------------------
create table if not exists public.evidence (
  id                   uuid primary key default gen_random_uuid(),
  property_id          uuid not null references public.properties(id) on delete cascade,
  measurement_id       uuid references public.measurements(id) on delete cascade, -- null for manually gathered evidence
  competitor_id        uuid references public.competitors(id),
  evidence_type        text not null
                       check (evidence_type in ('ai_citation','website_content','external_source','manual_note')),
  attributed_to        text not null default 'unattributed'
                       check (attributed_to in ('own_brand','competitor','unattributed')),
  url                  text,
  domain               text,
  title                text,
  excerpt              text,
  -- confidence metadata
  confidence_score     numeric(3,2) not null check (confidence_score between 0 and 1),
  confidence_level     text generated always as (
                         case when confidence_score >= 0.75 then 'high'
                              when confidence_score >= 0.50 then 'medium'
                              else 'low' end) stored,
  confidence_basis     text not null,        -- why we trust it this much
  verification_status  text not null default 'unverified'
                       check (verification_status in ('unverified','verified','disputed')),
  verified_by          text,
  verified_at          timestamptz,
  captured_at          timestamptz not null default now(),
  created_at           timestamptz not null default now()
);
create unique index if not exists evidence_dedupe_idx
  on public.evidence (measurement_id, url, attributed_to, competitor_id) nulls not distinct;
create index if not exists evidence_measurement_idx on public.evidence (measurement_id);

-- ---------------------------------------------------------------------
-- 6. Intelligence → diagnoses → recommendations
-- ---------------------------------------------------------------------
create table if not exists public.intelligence (
  id            uuid primary key default gen_random_uuid(),
  property_id   uuid not null references public.properties(id) on delete cascade,
  intent_id     uuid references public.intents(id) on delete cascade,
  engine_id     uuid references public.engines(id),   -- null = all engines
  period_start  date not null,
  period_end    date not null,
  insight_type  text not null
                check (insight_type in ('visibility_summary','visibility_gap','competitor_threat','trend','other')),
  title         text not null,
  summary       text,
  metrics       jsonb not null default '{}',
  generated_by  text not null default 'sql_rollup' check (generated_by in ('sql_rollup','agent','analyst')),
  created_at    timestamptz not null default now(),
  unique nulls not distinct (property_id, intent_id, engine_id, insight_type, period_start, period_end)
);

create table if not exists public.diagnoses (
  id               uuid primary key default gen_random_uuid(),
  measurement_id   uuid not null references public.measurements(id) on delete cascade,
  intelligence_id  uuid references public.intelligence(id) on delete set null,
  diagnosis_type   text not null
                   check (diagnosis_type in ('content_gap','citation_gap','entity_confusion',
                                             'negative_sentiment','competitor_dominance','other')),
  root_cause       text not null,
  severity         text not null check (severity in ('low','medium','high')),
  confidence_score numeric(3,2) check (confidence_score between 0 and 1),
  status           text not null default 'draft' check (status in ('draft','confirmed','rejected')),
  generated_by     text not null default 'analyst' check (generated_by in ('agent','analyst')),
  created_at       timestamptz not null default now(),
  unique (id, measurement_id)   -- lets recommendations enforce matching measurement
);

create table if not exists public.diagnosis_evidence (
  diagnosis_id  uuid not null references public.diagnoses(id) on delete cascade,
  evidence_id   uuid not null references public.evidence(id)  on delete cascade,
  role          text not null default 'supporting' check (role in ('supporting','contradicting')),
  primary key (diagnosis_id, evidence_id)
);

create table if not exists public.recommendations (
  id               uuid primary key default gen_random_uuid(),
  measurement_id   uuid not null references public.measurements(id) on delete cascade,
  diagnosis_id     uuid,
  title            text not null,
  detail           text,
  action_type      text not null check (action_type in ('content','technical','pr_outreach','listing','other')),
  priority         text not null default 'medium' check (priority in ('low','medium','high')),
  expected_impact  text,
  status           text not null default 'proposed'
                   check (status in ('proposed','approved','rejected','in_progress','done')),
  owner            text,
  due_date         date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- if a diagnosis is given it must belong to the same measurement
  foreign key (diagnosis_id, measurement_id) references public.diagnoses(id, measurement_id) on delete cascade
);
create index if not exists recommendations_measurement_idx on public.recommendations (measurement_id);

-- ---------------------------------------------------------------------
-- 7. Human feedback (human-in-the-loop review)
-- ---------------------------------------------------------------------
create table if not exists public.human_feedback (
  id                 uuid primary key default gen_random_uuid(),
  recommendation_id  uuid references public.recommendations(id) on delete cascade,
  diagnosis_id       uuid references public.diagnoses(id)       on delete cascade,
  evidence_id        uuid references public.evidence(id)        on delete cascade,
  measurement_id     uuid references public.measurements(id)    on delete cascade,
  reviewer           text not null,
  decision           text not null check (decision in ('approve','reject','edit','comment')),
  rating             integer check (rating between 1 and 5),
  comment            text,
  created_at         timestamptz not null default now(),
  check (num_nonnulls(recommendation_id, diagnosis_id, evidence_id, measurement_id) = 1)
);

-- ---------------------------------------------------------------------
-- 8. Activity history (audit log, filled by triggers)
-- ---------------------------------------------------------------------
create table if not exists public.activity_history (
  id           bigint generated always as identity primary key,
  entity_table text not null,
  entity_id    uuid not null,
  action       text not null check (action in ('insert','update','delete')),
  actor        text,
  changes      jsonb,
  occurred_at  timestamptz not null default now()
);
create index if not exists activity_entity_idx on public.activity_history (entity_table, entity_id);

create or replace function public.log_activity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_actor text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    current_user);
begin
  if tg_op = 'DELETE' then
    insert into activity_history (entity_table, entity_id, action, actor, changes)
    values (tg_table_name, old.id, 'delete', v_actor, to_jsonb(old));
    return old;
  elsif tg_op = 'UPDATE' then
    insert into activity_history (entity_table, entity_id, action, actor, changes)
    select tg_table_name, new.id, 'update', v_actor,
           jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
    where n.value is distinct from o.value
    having count(*) > 0;          -- skip no-op updates
    return new;
  else
    insert into activity_history (entity_table, entity_id, action, actor, changes)
    values (tg_table_name, new.id, 'insert', v_actor, to_jsonb(new));
    return new;
  end if;
end $$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists recommendations_touch on public.recommendations;
create trigger recommendations_touch before update on public.recommendations
  for each row execute function public.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['diagnoses','recommendations','human_feedback','intelligence'] loop
    execute format('drop trigger if exists %I_activity on public.%I', t, t);
    execute format('create trigger %I_activity after insert or update or delete on public.%I
                    for each row execute function public.log_activity()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Row Level Security: signed-in users can read/write; anon gets nothing.
--    (Your FastAPI backend using the service_role key bypasses RLS.)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['properties','engines','competitors','property_relationships','intents','prompts',
                           'prompt_generation_runs','import_batches',
                           'measurements','measurement_mentions','evidence','intelligence','diagnoses',
                           'diagnosis_evidence','recommendations','human_feedback','activity_history'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I_authenticated_all on public.%I', t, t);
    execute format('create policy %I_authenticated_all on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;
