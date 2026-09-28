-- =====================================================================
-- 00_drop_all.sql — permanently DELETE all GEO V1 tables, views and
-- functions so 01_schema.sql can be run again on a clean slate.
--
-- ⚠ This cannot be undone. All data in these tables is lost.
--   (Use 00_reset.sql instead if you want to keep a backup copy.)
--
-- The staging table (stg_rankscale_export) is kept by default, so you
-- don't have to import the CSV again. Uncomment the last line to drop it too.
-- =====================================================================

-- report views (07)
drop view if exists public.v_competitor_answer_scores cascade;
drop view if exists public.v_answer_scores            cascade;
drop view if exists public.v_domain_category          cascade;
drop table if exists public.report_notes              cascade;
drop table if exists public.benchmarks                cascade;
drop table if exists public.competitor_groups         cascade;
drop table if exists public.neutral_exclusion_terms   cascade;
drop table if exists public.source_categories         cascade;
drop function if exists public.classify_neutral_prompts() cascade;
drop function if exists public.name_matches(text, text[]) cascade;
drop function if exists public.seed_coogee_report() cascade;

-- dashboard views and views built on the staging table
drop view if exists public.v_recommendation_queue     cascade;
drop view if exists public.v_prompt_scorecard         cascade;
drop view if exists public.v_citation_domains         cascade;
drop view if exists public.v_competitor_share         cascade;
drop view if exists public.v_visibility_weekly        cascade;
drop view if exists public.v_visibility_intent_engine cascade;
drop view if exists public.v_kpis                     cascade;
drop view if exists public.v_measurements_flat        cascade;
drop view if exists public.stg_rankscale_measured cascade;
drop view if exists public.stg_rankscale_matched  cascade;

-- V1 tables (children first; cascade removes their triggers, indexes, policies)
drop table if exists public.activity_history       cascade;
drop table if exists public.human_feedback         cascade;
drop table if exists public.recommendations        cascade;
drop table if exists public.diagnosis_evidence     cascade;
drop table if exists public.diagnoses              cascade;
drop table if exists public.intelligence           cascade;
drop table if exists public.evidence               cascade;
drop table if exists public.measurement_mentions   cascade;
drop table if exists public.measurements           cascade;
drop table if exists public.prompts                cascade;
drop table if exists public.prompt_generation_runs cascade;
drop table if exists public.import_batches         cascade;
drop table if exists public.intents                cascade;
drop table if exists public.engines                cascade;
drop table if exists public.property_relationships cascade;
drop table if exists public.competitors            cascade;
drop table if exists public.properties             cascade;

-- leftover from the very first import attempt, if it exists
drop table if exists public.rankscale_results      cascade;

-- helper functions
drop function if exists public.is_own_brand(uuid, text)    cascade;
drop function if exists public.is_ignored_name(uuid, text) cascade;
drop function if exists public.split_keywords(text)        cascade;
drop function if exists public.log_activity()              cascade;
drop function if exists public.touch_updated_at()          cascade;

-- staging table: uncomment to drop it as well (you'll need to re-import the CSV)
-- drop table if exists public.stg_rankscale_export cascade;

-- check: lists whatever is left in public (should be empty, or only stg_rankscale_export)
select table_name, table_type from information_schema.tables where table_schema = 'public' order by 1;
