"""Convert a raw Rankscale export into a CSV that Supabase can import.

Rankscale's "CSV" is really UTF-16, tab-separated text, with line breaks
inside some fields. That is why Supabase's importer mangles it.
This script:
  * reads it as UTF-16 / tab-separated
  * keeps only the columns the GEO database uses (drops the ad_* and tags columns)
  * turns '-' and 'N/A' into empty cells (-> NULL), yes/no into true/false
  * strips the leading apostrophe Rankscale adds to some result_text values
  * writes UTF-8, comma-separated, properly quoted

Usage:  python convert_rankscale.py <rankscale_export.csv> [rankscale_staging.csv]
"""
import csv
import sys

DROP_PREFIXES = ("ad1_", "ad2_")
DROP_COLUMNS = {"tags", "chatgpt_shopping"}
BOOL_COLUMNS = {"ai_overview", "chatgpt_websearch", "brand_found"}
NULLS = {"-", "N/A", ""}


def clean(col, val):
    val = val.strip()
    if val in NULLS:
        return ""
    if col == "result_text" and val.startswith("'"):
        val = val[1:]
    if col in BOOL_COLUMNS:
        return {"yes": "true", "no": "false"}.get(val.lower(), val)
    return val


def main(src, dst):
    with open(src, encoding="utf-16", newline="") as f:
        rows = list(csv.reader(f, delimiter="\t"))
    header, data = rows[0], rows[1:]
    keep = [i for i, c in enumerate(header)
            if not c.startswith(DROP_PREFIXES) and c not in DROP_COLUMNS]
    bad = [n for n, r in enumerate(data, 2) if len(r) != len(header)]
    if bad:
        sys.exit(f"Rows with the wrong number of columns (line numbers): {bad[:20]}")
    with open(dst, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow([header[i] for i in keep])
        for r in data:
            w.writerow([clean(header[i], r[i]) for i in keep])
    print(f"Wrote {len(data)} rows x {len(keep)} columns to {dst}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "rankscale_staging.csv")
