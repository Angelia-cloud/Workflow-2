# Rankscale input file: data spec

This spec covers what the Rankscale export contains, what gets saved to Supabase, how each value is cleaned, and where it appears on the dashboard. It was checked against the 18 Sept 2026 Coogee export: 1,969 rows, 155 columns, 20 Aug – 17 Sept 2026.

## The file itself

| Property | Value | How the gateway handles it |
|---|---|---|
| Encoding | UTF-16 LE with BOM | Detected automatically. UTF-8 and cp1252 files are accepted too. |
| Delimiter | Tab (the `.csv` extension is misleading) | Detected from the header row |
| Line breaks inside fields | Yes (`result_text`, quoted) | Parsed with a real CSV reader, never split on lines |
| Null markers | `-`, `N/A`, empty | All become SQL `NULL` |
| One row per… | Brand name Rankscale spotted in an answer | Merged into one `measurements` row per prompt × engine × timestamp (155 duplicate rows in this file) |
| `result_text` prefix | Some values start with `'` (Excel formula guard) | Stripped |

## Column decisions

Fill rate is the share of the file's 1,969 rows that have a value.

### Kept: identifies what was measured

| CSV column | Fill | Saved to | Cleaning | Used on the dashboard for |
|---|---|---|---|---|
| `timestamp` | 100% | `measurements.measured_at` | ISO 8601 → `timestamptz`; must parse | Date filter, weekly trend |
| `brand_reference` | 100% | matched to `properties` via its aliases | Case-insensitive alias match; unmatched rows are skipped with a warning | Property selector |
| `topic_name` | 100% | `intents.name` | Trimmed; must not be empty | Intent filter, heatmap rows |
| `query` | 100% | `prompts.prompt_text` | Trimmed; must not be empty | Prompt scorecard |
| `ai_engine` | 100% | `engines.rankscale_code` → `measurements.engine_id` | Unknown codes are added to `engines` automatically | Engine filter, heatmap columns |
| `chatgpt_model` | 12% | `measurements.engine_model` | — | Answer detail |

### Kept: the outcome for the hotel

| CSV column | Fill | Saved to | Cleaning | Used on the dashboard for |
|---|---|---|---|---|
| `brand_found` | 100% | `measurements.brand_found` | yes/no → boolean; must be valid | "Rankscale visibility" KPI |
| *(derived)* | — | `measurements.brand_found_any_alias` | True if any confirmed hotel name appears in the ranked list | Headline "Visibility" KPI, heatmap, scorecard |
| `brand_rank` | 48% | `measurements.own_brand_rank` | Whole number; the best rank is kept when rows are merged | Average rank KPI, best rank |
| `brand_name_mentioned` | 48% | `measurements.own_brand_name_mentioned` | — | Shows which name Rankscale matched |
| `sentiment`, `sentiment_reason` | 48% | `measurements.own_brand_sentiment` / `_reason` | Number 0–1 | Average sentiment KPI |
| `brands_total` | 100% | `measurements.brands_total` | Whole number | Answer detail |
| `visibility_score_latest/24h/7d/30d` | 49–73% | `measurements.visibility_score_*` | Number | Kept for comparison with Rankscale's own dashboard |
| `result_text` | 100% | `measurements.response_text` | Strip leading `'` | Answer detail; diagnosis agent input |

### Kept: competitors (rank 1–15, seven fields each)

| CSV columns | Fill (rank 1 / 5 / 10 / 15) | Saved to | Cleaning | Used on the dashboard for |
|---|---|---|---|---|
| `rankN_brandname` | 91% / 37% / 3% / 0.2% | `measurement_mentions` (one row per rank); non-hotel names → `competitors` | Hotel aliases are flagged `is_own_brand`; ignored names (Club InterContinental) are dropped | "Who takes the answers" chart; brands ranked in answer detail |
| `rankN_sentiment`, `_sentiment_reason` | as above | `measurement_mentions.sentiment` / `_reason` | Number 0–1 | Answer detail |
| `rankN_positive/neutral/negative_keywords` | as above | `measurement_mentions.*_keywords` (`text[]`) | Split on `;` | "Described as" column |
| `rankN_citations` | as above | `evidence` (attributed to the competitor, confidence 0.80) | Split on `,` before each `http` | Sources engines cite |

### Kept: sources

| CSV column | Fill | Saved to | Cleaning | Used on the dashboard for |
|---|---|---|---|---|
| `brand_citations` | 37% | `evidence` (attributed to the hotel, confidence 0.80) | Comma-split URLs; domain extracted | Sources table ("Hotel" column); own-site checks |
| `other_citations` | 80% | `evidence` (unattributed, confidence 0.50) | as above | Sources table ("Other" column) |

### Kept, but only as context for agents

| CSV column | Fill | Saved to | Why it's kept |
|---|---|---|---|
| `chatgpt_websearch` | 19% | `measurements.used_web_search` | Tells the diagnosis agent whether the answer was search-grounded |
| `ai_overview` | 16% | `measurements.ai_overview_present` | Whether Google showed an AI Overview |
| `web_search_queries` | 50% | `measurements.web_search_queries` | The searches an engine ran; useful for prompt research |
| `related_prompts` | 9% | `prompts.related_prompts` (`text[]`) | Seeds for the prompt-generation agents |

### Dropped

| CSV column(s) | Fill | Why it's dropped |
|---|---|---|
| `ad1_*`, `ad2_*` (22 columns) | 2% / 0.5% | Shopping ads in ChatGPT; almost always empty and not part of GEO visibility |
| `tags` | 0% | Always empty |
| `chatgpt_shopping` | 19% | Always "no" in this data |
| Top-level `positive/neutral/negative_keywords` | 48% | Duplicate the hotel's own `rankN_*_keywords`, which are already saved on its mention row |

## Validation rules (the import gateway)

- **Refuse the whole file** if any required column is missing (`timestamp`, `brand_reference`, `topic_name`, `query`, `ai_engine`, `brand_found`, `result_text`). Also refuse it if more than 10% of rows fail row checks. Nothing is written, and the attempt is logged in `import_batches` with status `rejected`.
- **Reject a single row** if its column count differs from the header, a required value is empty, `brand_found` isn't yes/no, a number or rank doesn't parse, or the timestamp isn't ISO. The report lists each rejected row with its line number.
- **Warn** about duplicate answer rows (they're merged) and about `brand_reference` values that match no property (those rows are skipped).
- **Re-uploading is safe.** Every table has a unique key (prompt × engine × timestamp for answers; answer × rank for mentions; answer × URL × attribution for evidence), so loading the same file twice adds nothing.
- **Loads are all-or-nothing.** A load runs in one transaction, so it either completes fully or leaves the database untouched.

## Hotel names (who counts as "us")

Stored in `properties.aliases` and confirmed by the supervisor on 24 Sept 2026. The list covers the InterContinental names, the Shutters, Rick Stein and Èliva outlet names, and the pre-rebrand Crowne Plaza Coogee names. `Club InterContinental` is in `properties.ignored_names`: it's neither the hotel nor a competitor. To add a name, edit the list at the top of `db/03_load_rankscale.sql` and reload.
