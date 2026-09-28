-- =====================================================================
-- Checks for the "test with real Coogee data" acceptance criteria.
-- Run each query on its own in the SQL Editor and screenshot the result.
-- =====================================================================

-- A. Row counts per table
select 'properties' as table_name, count(*) from properties
union all select 'engines', count(*) from engines
union all select 'intents', count(*) from intents
union all select 'prompts', count(*) from prompts
union all select 'measurements', count(*) from measurements
union all select 'measurement_mentions', count(*) from measurement_mentions
union all select 'competitors', count(*) from competitors
union all select 'property_relationships', count(*) from property_relationships
union all select 'evidence', count(*) from evidence
union all select 'intelligence', count(*) from intelligence
union all select 'diagnoses', count(*) from diagnoses
union all select 'diagnosis_evidence', count(*) from diagnosis_evidence
union all select 'recommendations', count(*) from recommendations
union all select 'human_feedback', count(*) from human_feedback
union all select 'activity_history', count(*) from activity_history;

-- B. Table connections: the Coogee example walked end to end
select p.name as property, i.name as intent, left(pr.prompt_text, 60) as prompt,
       e.name as engine, m.measured_at, m.brand_found, m.brands_total,
       d.diagnosis_type, d.severity, d.status as diagnosis_status,
       r.title as recommendation, r.priority, r.status as rec_status
from diagnoses d
join measurements m     on m.id = d.measurement_id
join engines e          on e.id = m.engine_id
join prompts pr         on pr.id = m.prompt_id
join intents i          on i.id = pr.intent_id
join properties p       on p.id = i.property_id
join recommendations r  on r.diagnosis_id = d.id
order by r.priority, r.title;

-- C. One measurement → many recommendations
select m.id as measurement_id, e.name as engine, count(r.id) as recommendations
from measurements m
join engines e         on e.id = m.engine_id
join recommendations r on r.measurement_id = m.id
group by m.id, e.name
having count(r.id) > 1;

-- D. Evidence confidence metadata for the example measurement
select e.evidence_type, e.attributed_to, c.name as competitor, e.domain,
       e.confidence_score, e.confidence_level, e.verification_status, e.confidence_basis,
       (de.diagnosis_id is not null) as linked_to_diagnosis
from evidence e
left join competitors c        on c.id = e.competitor_id
left join diagnosis_evidence de on de.evidence_id = e.id
where e.measurement_id = (select measurement_id from diagnoses order by created_at limit 1)
order by linked_to_diagnosis desc, e.confidence_score desc, e.domain;

-- E. Competitors in the example answer, by rank
select mm.rank, mm.brand_name_raw, mm.is_own_brand, mm.sentiment, mm.positive_keywords
from measurement_mentions mm
where mm.measurement_id = (select measurement_id from diagnoses order by created_at limit 1)
order by mm.rank;

-- F. Human feedback and activity history for the example
select 'recommendation' as target, r.title as target_name, hf.reviewer, hf.decision, hf.rating, hf.comment
from human_feedback hf join recommendations r on r.id = hf.recommendation_id
union all
select 'diagnosis', left(d.root_cause, 60), hf.reviewer, hf.decision, hf.rating, hf.comment
from human_feedback hf join diagnoses d on d.id = hf.diagnosis_id
union all
select 'evidence', e.domain, hf.reviewer, hf.decision, hf.rating, hf.comment
from human_feedback hf join evidence e on e.id = hf.evidence_id;

select entity_table, action, actor, occurred_at,
       case when action = 'update' then changes::text else '(new row)' end as change
from activity_history
where entity_table <> 'intelligence'   -- roll-up inserts are noisy; drop this line to see them
order by id;

-- G. Intelligence: where is the hotel least visible? (intent level, all engines)
select i.name as intent, intel.insight_type,
       (intel.metrics->>'answers')::int as answers,
       (intel.metrics->>'answers_with_brand')::int as with_brand,
       (intel.metrics->>'brand_found_rate')::numeric as found_rate,
       intel.metrics->'top_competitors' as top_competitors
from intelligence intel
join intents i on i.id = intel.intent_id
where intel.engine_id is null
order by found_rate;

-- H. Integrity checks — every query here should return 0
select 'measurements without prompt' as check, count(*) from measurements m left join prompts p on p.id = m.prompt_id where p.id is null
union all select 'duplicate measurements', count(*) - count(distinct (prompt_id, engine_id, measured_at)) from measurements
union all select 'mentions pointing to own brand as competitor', count(*) from measurement_mentions where is_own_brand and competitor_id is not null
union all select 'recs whose diagnosis is on another measurement', count(*)
          from recommendations r join diagnoses d on d.id = r.diagnosis_id where d.measurement_id <> r.measurement_id;

-- I. Rankscale's brand_found vs any-alias match, by intent
--    (the gap = answers that mention the hotel under a name Rankscale isn't set up for)
select i.name as intent,
       count(*) as answers,
       count(*) filter (where m.brand_found)           as found_rankscale,
       count(*) filter (where m.brand_found_any_alias) as found_any_alias,
       count(*) filter (where m.brand_found_any_alias and not m.brand_found) as missed_by_rankscale
from measurements m
join prompts pr on pr.id = m.prompt_id
join intents i  on i.id = pr.intent_id
group by i.name
order by missed_by_rankscale desc;

-- J. Which names Rankscale missed
select mm.brand_name_raw, count(distinct m.id) as answers
from measurements m
join measurement_mentions mm on mm.measurement_id = m.id and mm.is_own_brand
where not m.brand_found
group by mm.brand_name_raw
order by answers desc;
