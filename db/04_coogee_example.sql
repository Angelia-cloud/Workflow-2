-- =====================================================================
-- First Coogee test case, built on a real measurement from the export:
--   Prompt : "Where can I host a baby shower in Sydney at an oceanfront
--             restaurant or hotel venue?"   (intent: Romance & Events)
--   Engine : ChatGPT, 16 Sep 2026 — 11 venues recommended, hotel not mentioned.
--
-- Shows the full chain:
--   property → intent → prompt → measurement
--     → mentions (competitors) + evidence (with confidence)
--     → intelligence → diagnosis (+ linked evidence)
--     → 3 recommendations on the SAME measurement (one-to-many)
--     → human feedback → activity history (written by triggers)
--
-- Diagnosis and recommendations are draft analyst content: edit the wording
-- with Tanya before showing it to Truc. The feedback rows are marked as tests.
-- Re-running this file does nothing if the example already exists.
-- =====================================================================
do $$
declare
  v_property     uuid;
  v_measurement  uuid;
  v_intel        uuid;
  v_diag         uuid;
  v_rec1         uuid;
  v_rec2         uuid;
  v_rec3         uuid;
  v_pier_one     uuid;
  v_manual_ev    uuid;
begin
  select id into v_property from properties where name = 'InterContinental Sydney Coogee Beach';

  select m.id into v_measurement
  from measurements m
  join prompts pr on pr.id = m.prompt_id
  join engines e  on e.id = m.engine_id
  where pr.prompt_text like 'Where can I host a baby shower in Sydney%'
    and e.rankscale_code = 'chatgpt_gui'
  order by m.measured_at desc
  limit 1;

  if v_measurement is null then
    raise exception 'Baby shower / ChatGPT measurement not found — run 03_load_rankscale.sql first';
  end if;

  if exists (select 1 from diagnoses where measurement_id = v_measurement) then
    raise notice 'Coogee example already loaded — nothing to do';
    return;
  end if;

  -- intelligence row this diagnosis explains (Romance & Events × ChatGPT roll-up)
  select intel.id into v_intel
  from intelligence intel
  join prompts pr on pr.intent_id = intel.intent_id
  join measurements m on m.prompt_id = pr.id
  where m.id = v_measurement and intel.engine_id = m.engine_id
  order by intel.created_at desc
  limit 1;

  -- mark the top-ranked competitor in this answer as part of the tracked set
  select competitor_id into v_pier_one
  from measurement_mentions where measurement_id = v_measurement and rank = 1;

  update property_relationships
     set is_tracked = true, relationship_type = 'tracked_competitor',
         notes = 'Ranked #1 for baby shower prompt on ChatGPT (16 Sep 2026)'
   where property_id = v_property and competitor_id = v_pier_one;

  -- one piece of manually captured evidence, taken from the answer text itself
  insert into evidence (property_id, measurement_id, competitor_id, evidence_type, attributed_to,
                        url, domain, excerpt, confidence_score, confidence_basis)
  values (v_property, v_measurement, v_pier_one, 'external_source', 'competitor',
          'https://www.pieronesydneyharbour.com.au/social-events-sydney', 'pieronesydneyharbour.com.au',
          'ChatGPT: "It specifically caters for occasions including baby showers."',
          0.60, 'Claim made in the AI answer and backed by a cited page; the page itself has not been opened yet')
  returning id into v_manual_ev;

  -- diagnosis
  insert into diagnoses (measurement_id, intelligence_id, diagnosis_type, root_cause,
                         severity, confidence_score, status, generated_by)
  values (v_measurement, v_intel, 'content_gap',
          'ChatGPT recommended 11 Sydney venues for a baby shower and did not mention the hotel. '
          || 'The venues it cited have pages that name the occasion outright '
          || '(e.g. sanmartin.com.au/baby-shower-venue-sydney, sergeantsmess.com.au/baby-shower-function-venue, '
          || 'Pier One''s social-events page). The engine appears to favour venues whose own content '
          || 'explicitly lists baby showers; the hotel has no cited page making that claim.',
          'high', 0.70, 'draft', 'analyst')
  returning id into v_diag;

  -- link the supporting evidence: occasion-specific citations in this answer + the manual note
  insert into diagnosis_evidence (diagnosis_id, evidence_id, role)
  select v_diag, e.id, 'supporting'
  from evidence e
  where e.measurement_id = v_measurement
    and (e.url ~* '(baby-shower|social-events|functions|private)' or e.id = v_manual_ev)
  on conflict do nothing;

  -- three recommendations on the same measurement (the one-to-many relationship)
  insert into recommendations (measurement_id, diagnosis_id, title, detail, action_type, priority, expected_impact)
  values (v_measurement, v_diag,
          'Publish a dedicated baby shower & celebrations page',
          'A page on coogeebeach.intercontinental.com that names baby showers (plus bridal showers and birthdays) '
          || 'and gives spaces, capacities, packages and an enquiry path. Mirror the structure of the pages ChatGPT cited.',
          'content', 'high', 'Gives engines a citable source for occasion-led prompts')
  returning id into v_rec1;

  insert into recommendations (measurement_id, diagnosis_id, title, detail, action_type, priority, expected_impact)
  values (v_measurement, v_diag,
          'Add FAQ and event structured data to the celebrations page',
          'FAQ entries such as "Can I host a baby shower at InterContinental Sydney Coogee Beach?" with schema.org '
          || 'FAQPage/EventVenue markup, so the occasion is machine-readable.',
          'technical', 'medium', 'Makes the occasion match easier for engines to extract')
  returning id into v_rec2;

  insert into recommendations (measurement_id, diagnosis_id, title, detail, action_type, priority, expected_impact)
  values (v_measurement, v_diag,
          'Get listed on third-party venue guides cited for occasion prompts',
          'Review the unattributed citations for occasion prompts (evidence table) and target the venue '
          || 'directories and guides that appear repeatedly.',
          'listing', 'medium', 'Adds external sources that corroborate the hotel as an occasion venue')
  returning id into v_rec3;

  -- human-in-the-loop review (test rows)
  insert into human_feedback (recommendation_id, reviewer, decision, rating, comment)
  values (v_rec1, 'Test reviewer', 'approve', 4, '[V1 test record] Approve in principle — confirm package details with the hotel.'),
         (v_rec3, 'Test reviewer', 'comment', null, '[V1 test record] Need the list of repeat-cited directories first.');

  insert into human_feedback (diagnosis_id, reviewer, decision, comment)
  values (v_diag, 'Test reviewer', 'approve', '[V1 test record] Diagnosis matches the prompt-level analysis.');

  insert into human_feedback (evidence_id, reviewer, decision, comment)
  values (v_manual_ev, 'Test reviewer', 'comment', '[V1 test record] Open the Pier One page and mark this verified or disputed.');

  -- status changes (these are captured in activity_history as updates)
  update diagnoses       set status = 'confirmed' where id = v_diag;
  update recommendations set status = 'approved'  where id = v_rec1;

  raise notice 'Coogee example loaded: measurement %, diagnosis %, recommendations %, %, %',
               v_measurement, v_diag, v_rec1, v_rec2, v_rec3;
end $$;
