# GEO Automation Platform (V1)

This is the human-in-the-loop GEO system for the InterContinental Sydney Coogee Beach pilot.

**Stack:** Python (FastAPI) + Supabase (Postgres) + Groq running GPT-OSS 20B for the agents.

- **Workflow 1:** upload a Rankscale export → validate and clean it → save it to Supabase → dashboard.
- **Diagnosis agent:** explains why the hotel did or didn't appear in an answer and proposes draft recommendations. People review them.
- **Upstream prompt-generation agents** (3): produce new prompts to track, exported as a file to import into Rankscale.

```
geo-platform/
├── app/                    FastAPI backend + Workflow 1 UI (app/static)
│   ├── main.py             all API endpoints
│   ├── ingest.py           file parsing, cleaning, validation
│   └── loader.py           transactional load into Supabase
├── agents/
│   ├── llm.py              one interface for Groq (default) / Anthropic / OpenAI, plus a test stub
│   ├── diagnosis/          diagnosis agent: input brief, system prompt, output schema
│   └── prompt_generation/  Intent Mapper → Prompt Writer → Prompt QA, plus property briefs
├── db/                     SQL migrations and scripts (run in the Supabase SQL Editor)
├── docs/                   data spec, diagnosis framework, prompt-generation design
├── scripts/convert_rankscale.py   stand-alone converter (no server needed)
├── sample_data/            a one-week slice of the Coogee export for tests
└── tests/                  end-to-end tests against a real Postgres
```

## 1. Set up Supabase (once)

In the SQL Editor, run these in order:

| Step | File | What it does |
|---|---|---|
| 1 | `db/00_drop_all.sql` | *Only if you've set it up before.* Deletes the old GEO tables. Use `00_reset.sql` instead to keep a backup. |
| 2 | `db/01_schema.sql` | Creates all tables, keys, triggers and security policies |
| 3 | `db/02_staging_table.sql` | Creates the holding table the import uses internally |
| 4 | `db/06_dashboard_views.sql` | Creates the views the dashboard reads |
| 5 | `db/07_report.sql` | Adds the monthly-report model: neutral prompt set, tracked competitors, benchmarks, source categories, report notes |

Then load data one of two ways:
- **Recommended:** start the app (below) and use the **Upload data** tab with the file exactly as Rankscale downloads it.
- **Manual:** convert the file with `python scripts/convert_rankscale.py export.csv`, import the result into `stg_rankscale_export` in Table Editor, then run `db/03_load_rankscale.sql`.

After the first load, you can run `db/04_coogee_example.sql` (the worked Coogee test case) and `db/05_verify.sql` (the acceptance checks).

## 2. Run the app

```bash
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # then fill in DATABASE_URL and GROQ_API_KEY
uvicorn app.main:app --reload
```

Open http://localhost:8000 for the UI, or http://localhost:8000/docs for the API explorer.

`DATABASE_URL` comes from Supabase → **Connect** → **Session pooler** → URI (port 5432). The app talks to Postgres directly, so it doesn't need the anon or service keys.

## The Report tab

The Report tab is the monthly Komosion GEO report, rebuilt live from Supabase. It has the same sections as the August 2026 PDF: executive overview, performance overview, prompt sets, competitive position, neutral benchmark, intent intelligence, why AI chooses, source intelligence, and engagement. Pick the period (last 30 days, a calendar month, or a custom range), choose whether to count the hotel by Rankscale's detection or by every confirmed name, and click **Print / save as PDF** to get a client-ready copy.

**Metrics** reproduce Rankscale's own numbers:

| Metric | Definition |
|---|---|
| Visibility Score | Average answer score. An answer scores 100 ÷ (1 + 0.1 × (rank − 1)) when the hotel is mentioned (rank 1 = 100, rank 2 = 90.9, rank 3 = 83.3) and 0 when it isn't. This matches the per-row scores in the Rankscale export exactly. |
| Detection Rate | % of answers that mention the hotel |
| Average Position | Average rank, counting only answers that mention the hotel |
| Top 3 | % of answers where the hotel ranks 1–3 |
| Sentiment Score | Average sentiment × 100, counting only answers that mention the hotel |

**What you can change** (all rows live in Supabase):

| To change… | Edit |
|---|---|
| The tracked competitor set, or a competitor's name variants | `competitor_groups` |
| Which prompts count as neutral (the 17-prompt set) | `neutral_exclusion_terms`: any prompt containing a listed term is brand/location-specific |
| Baselines, benchmarks and targets | `benchmarks`, or `PUT /api/report/{property_id}/benchmarks` |
| How a cited domain is grouped | `source_categories` (LIKE patterns) or `properties.own_domains` |
| "What we'll monitor next" | Type in the box on the Report tab; it saves per reporting period |

The pre-schema baseline figures were back-calculated from the movements in the Aug 2026 report (e.g. 40.47 at +16.5% → 34.74), so they're flagged `is_derived`. Replace them with the original baseline figures if you have them.

## 3. Weekly routine

1. Download the export from Rankscale.
2. Upload data tab → **Check file** → **Load into Supabase**. Loading the same file twice is harmless.
3. Dashboard: look at the heatmap and scorecard, open answers, and click **Diagnose with agent** on the misses (or run `python -m agents.diagnosis.agent --auto 10`).
4. Review tab: approve, reject or comment on the recommendations.
5. Prompt generation tab (when you want new prompts): **Run agents** → approve → **Export approved for Rankscale** → import the file in Rankscale → Search Terms.

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/imports` | Upload a Rankscale export (`file`, `dry_run`, `uploaded_by`) |
| GET | `/api/imports` | Import history |
| GET | `/api/dashboard/{property_id}/kpis \| intent-engine \| weekly \| competitors \| citations \| prompts` | Dashboard data, filterable by `intent`, `engine`, `date_from`, `date_to` |
| GET | `/api/prompts/{id}/answers`, `/api/measurements/{id}` | Drill-down |
| POST | `/api/diagnoses/run` | Run the diagnosis agent on one answer |
| GET | `/api/recommendations` | Review queue |
| POST | `/api/feedback` | Approve, reject or comment on a recommendation, diagnosis, evidence row or measurement |
| POST | `/api/prompt-generation/run` | Run the three prompt agents |
| GET/POST | `/api/prompt-generation/candidates`, `/status`, `/export.csv` | Approve candidates and export the Rankscale file |

## Tests

```bash
DATABASE_URL=postgresql://…  python -m pytest -q
```

These run against a real database: file validation, a full load, an idempotent reload, and both agent pipelines (with a stub LLM, so no API cost). Point them at a **test** project or a local Postgres, not production.

## Adding another hotel

1. Insert a row into `properties` with its name, website, `aliases` (every name engines use, including outlets), `ignored_names` and `own_domains`.
2. Add a brief in `agents/prompt_generation/briefs/`.
3. Upload that hotel's Rankscale export. Rows are matched to the property through `brand_reference`.

For Coogee, `db/03_load_rankscale.sql` also resets the property's alias list on every load, so edit the list there (not only in the table).

## Docs

- `docs/data_spec.md`: every CSV column, whether it's kept, where it goes, how it's cleaned, and where it appears on the dashboard
- `docs/diagnosis_framework.md`: the diagnosis agent's inputs, prompt and outputs
- `docs/prompt_generation.md`: the three upstream agents and the Rankscale round trip

## Groq free-tier limits

GPT-OSS 20B on Groq's free plan allows 30 requests and 8K tokens per minute, and 200K tokens per day. One diagnosis uses about 4–8K tokens, so plan on **roughly 25 diagnoses a day**; the client waits and retries automatically when it hits the per-minute limit. A prompt-generation run of 30 prompts uses about 8 calls. For more volume, upgrade the Groq plan and raise `GEO_LLM_REASONING` and `GEO_LLM_MAX_OUTPUT` in `.env`.
