"""Find invented business data rendered as if it were the tenant's own.

    cd production && python scripts/find-fake-data.py

─── WHY A SECOND SCRIPT ────────────────────────────────────────────────────
`find-fake-actions.py` finds controls that do nothing. It could never have
found the two worst things in the same sweep:

  · /online-orders printed "Hotel Asia provisioning is stuck — fix to unblock
    ₹4.9L revenue. Cosmo Tech is on Day 11… Beta Industries just signed up",
    beside {issues} and {trialEx}, which ARE real counts. Prose, not a handler.
  · /partners rendered a hardcoded partner with MRR ₹1,45,800 and Invoiced
    ₹2,64,000 as its EMPTY STATE. JSX, not a handler.

Both were found by reading. This looks for the shape deliberately.

─── WHAT IT LOOKS FOR, AND WHERE ───────────────────────────────────────────
Only the surfaces that must show one tenant's real data: the staff app and the
customer portal. NOT src/site or (marketing) — a landing page quoting "₹49.99"
or naming an example customer is doing its job, and NOT tests, whose fixtures
are supposed to be invented.

  1. money literals inside a render: rupee(145800), value={42}
  2. GSTINs and Indian phone numbers written into JSX
  3. capitalised multi-word company-shaped names in visible strings

Every hit is a CANDIDATE, not a verdict: a hardcoded 0 is usually fine, and a
label like "Business Standard" is a product name. Read the line before acting.
"""
import io, os, re, glob

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

ROOTS = ["src/app/(app)", "src/app/(public)/portal", "src/components/features"]
SKIP = re.compile(r"\.test\.|\.spec\.|/__")

files = []
for r in ROOTS:
    files += [f for f in glob.glob(os.path.join(r, "**", "*.tsx"), recursive=True)
              if not SKIP.search(f.replace("\\", "/"))]

# ── the patterns ───────────────────────────────────────────────────────────
MONEY = re.compile(r"\brupee\(\s*(\d{4,})\s*\)")           # rupee(145800) — 4+ digits
METRIC = re.compile(r"value=\{\s*(\d{2,})\s*\}")            # value={380}
GSTIN = re.compile(r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z\d]Z[A-Z\d]\b")
PHONE = re.compile(r"\+91[\s-]?\d{5}[\s-]?\d{5}")
LAKH = re.compile(r"₹\s?[\d.]+\s?(?:L|Cr|lakh|crore)", re.I)
# "Hotel Asia", "Beta Industries", "Excel Technologies" — Two Capitalised Words
# inside a JSX text node or a quoted string, excluding known product vocabulary.
NAME = re.compile(r"\b([A-Z][a-z]{2,}\s+(?:[A-Z][a-z]{2,}\s+)?"
                  r"(?:Technologies|Industries|Enterprises|Solutions|Traders|Pvt|Ltd|Asia|Corp|Systems|Digital))\b")
ALLOW_NAMES = re.compile(r"Anutech|ResellerOS|Google|Microsoft|Zoho|Razorpay|Sandbox|DirectAdmin|"
                         r"ResellerClub|Cloud Digital|Business Standard|Workspace")

findings = []
for f in sorted(set(files)):
    src = io.open(f, encoding="utf-8").read()
    # comments are commentary, not render output — strip them before looking
    code = re.sub(r"/\*[\s\S]*?\*/", "", src)
    code = re.sub(r"(^|[^:])//.*$", r"\1", code, flags=re.M)
    for i, line in enumerate(code.split("\n"), 1):
        # A placeholder, an <option> value or a title= is not fabricated data —
        # it is how a form teaches its own format. Excluded, or the report is
        # 90% noise and stops being read.
        if re.search(r"placeholder=|<option value=|title=\"|aria-label=|e\.g\.|E\.g\.", line):
            continue
        hits = []
        if MONEY.search(line):   hits.append("money literal " + MONEY.search(line).group(0))
        if METRIC.search(line):  hits.append("metric literal " + METRIC.search(line).group(0))
        if GSTIN.search(line):   hits.append("GSTIN " + GSTIN.search(line).group(0))
        if PHONE.search(line):   hits.append("phone " + PHONE.search(line).group(0))
        if LAKH.search(line):    hits.append("amount " + LAKH.search(line).group(0))
        m = NAME.search(line)
        if m and not ALLOW_NAMES.search(line):
            hits.append(f'company-shaped name "{m.group(1)}"')
        if hits:
            findings.append((f.replace("\\", "/"), i, hits, line.strip()[:96]))

print(f"candidate fabricated-data lines: {len(findings)}\n")
by_file = {}
for f, i, hits, text in findings:
    by_file.setdefault(f, []).append((i, hits, text))
for f in sorted(by_file):
    print(f"  {f}")
    for i, hits, text in by_file[f]:
        print(f"      :{i}  {', '.join(hits)}")
        print(f"          {text}")
    print()
