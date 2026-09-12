"""Find comments that point at things which no longer exist.

    cd production && python scripts/find-stale-claims.py

─── WHY ────────────────────────────────────────────────────────────────────
This codebase comments unusually well: most blocks say WHY, name the file that
sets the pattern, and cite the date a bug was found. That is a real asset — and
it decays silently, because nothing checks a sentence.

Seven false claims turned up by accident in one day's work (12 Sep 2026), each
of which had been read and believed at least once:

  · "Eleven other scripts in this directory carry the same block"   — it was 8
  · "x-forwarded-for ki PEHLI entry hi client hai"                  — the opposite
  · "we read the REAL client IP … the browser can't forge it"       — it can
  · "Read from x-forwarded-for because Vercel terminates TLS"       — it is Cloud Run
  · "replace ONLINE_ORDERS with a Supabase query on an orders table" — already done
  · "Merged (TopBar Workspace Switcher Active)"                     — removed 13 Aug
  · TASKS.md: "PR #1 + #2 merged to main"                           — never merged

A wrong comment is worse than none: the first three sent somebody to rotate a
service-role key that was fine, and to trust an office-network gate that was
bypassable with one curl flag.

─── WHAT THIS CAN AND CANNOT CHECK ─────────────────────────────────────────
Prose cannot be verified by a script. What CAN is the subset of claims that
name something the repo either has or does not:

  1. `path/to/file.ts` or `path/to/file.tsx:123` — does the file exist?
  2. `someFunction()` or `<Component>` in backticks — is the identifier
     anywhere in src/, supabase/ or scripts/?
  3. migration numbers — does a matching file exist?

Everything else — a count, a date, a claim about behaviour — still needs a
person. This narrows the haystack; it does not replace reading.

Hits are CANDIDATES. A comment may legitimately name a deleted file while
explaining why it was deleted, which is exactly what several of this week's
commits do. Read the line.
"""
import io, os, re, glob

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SRC_GLOBS = ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.mjs", "scripts/**/*.py"]
files = []
for g in SRC_GLOBS:
    files += glob.glob(g, recursive=True)
files = sorted(set(f for f in files if ".test." not in f and ".spec." not in f))

def strip_comments(text):
    """Comments out — the haystack must be CODE only.

    Without this the identifier check can never fire, and for a while it did
    not: the haystack was raw file text, so a name appearing ONLY in a comment
    was found in that very comment and judged to exist. Proved by planting
    `computeNothingAtAll()` in a comment — the check returned 0, the same 0 it
    had returned on every run since it was written. A check that has only ever
    said "clean" is indistinguishable from one that is broken, which is why
    both checks in this file are mutation-tested before being believed.
    """
    text = re.sub(r"/\*[\s\S]*?\*/", " ", text)
    text = re.sub(r"^[ \t]*//.*$", " ", text, flags=re.M)
    text = re.sub(r"^[ \t]*#.*$", " ", text, flags=re.M)
    text = re.sub(r"--.*$", " ", text, flags=re.M)          # SQL line comments
    return text


# every identifier the repo DEFINES OR USES IN CODE, so a name can be looked up
haystack_parts = []
for g in ["src/**/*.ts", "src/**/*.tsx", "supabase/**/*.sql", "scripts/**/*.mjs", "scripts/**/*.py"]:
    for f in glob.glob(g, recursive=True):
        try:
            haystack_parts.append(strip_comments(io.open(f, encoding="utf-8", errors="ignore").read()))
        except OSError:
            pass
HAYSTACK = "\n".join(haystack_parts)

# Consecutive `//` lines are ONE comment, not several. Matching line-by-line
# split feedback/triage's block in two: the line naming
# src/components/attendance/ReminderPopup.tsx landed in a different block from
# the line saying "Neither exists", so the disclaimer could not suppress it. A
# paragraph argues across its lines; the parser has to read it the same way.
COMMENT = re.compile(
    r"/\*[\s\S]*?\*/"           # block comment
    r"|(?:^[ \t]*//.*$\n?)+"    # a RUN of // lines
    r"|(?:^[ \t]*#.*$\n?)+",    # a RUN of # lines
    re.M,
)
FILEREF = re.compile(r"\b((?:[\w./-]+/)?[\w.-]+\.(?:tsx?|mjs|sql|py|css|json))(?::(\d+))?\b")
IDENT = re.compile(r"`([A-Za-z_$][\w$]*)\(\)`|`<([A-Z][\w$]*)\s*/?>`")

# names that are library/runtime, not ours
EXTERNAL = re.compile(r"^(fetch|require|console|JSON|Math|Object|Array|String|Number|Boolean|Promise|"
                      r"Date|Error|Set|Map|Buffer|process|window|document|localStorage|sessionStorage|"
                      r"setTimeout|setInterval|encodeURIComponent|decodeURIComponent|parseInt|parseFloat)$")
NOT_A_FILE = re.compile(r"^(package\.json|tsconfig\.json|README\.md|node_modules)")

missing_files, missing_idents = [], []
for f in files:
    try:
        src = io.open(f, encoding="utf-8", errors="ignore").read()
    except OSError:
        continue
    for m in COMMENT.finditer(src):
        block = m.group(0)
        line_no = src[: m.start()].count("\n") + 1

        """A comment may legitimately name something this repo does not have.
           Three shapes do it so often that including them buries the signal:
             · a file in the OTHER repo  ("Ported from the DMS engine's …")
             · an HTTP endpoint ending .json (ResellerClub's API), or a method
               call such as NextResponse.json
             · a comment whose whole POINT is that the thing does not exist —
               feedback/triage explains that Gemini invented two paths
           Measured 12 Sep 2026: 46 raw candidates, 45 of them one of these,
           and one real (utils.ts named formatDate.test.ts; the file is
           format-date-ist.test.ts). A 46-line report with one real row in it
           is a report that gets skimmed. """
        low = block.lower()
        """Each pattern here is a REAL false positive this check produced, not a
           guess. Triaged 12 Sep 2026, and they were four different kinds:
             · the other repo, named either "DMS engine" or in full
               ("domain-management-system: lib/pricing-service.ts")
             · a comment whose point is that the path does NOT exist
               (feedback/triage, explaining two paths Gemini invented)
             · a HYPOTHETICAL future file — swipe-lead-card says "if these
               labels diverge we can lift to lib/lead-stages.ts"
             · a quoted COMPILER ERROR naming a generated path — gate.mjs
               quotes "File '.next/types/…/page.ts' not found"
           The long tail is the honest signal here: there are many legitimate
           reasons to name a path this repo does not have, so treat every
           remaining row as a question, not a defect. """
        if re.search(r"ported from|dms engine|domain-management-system|other repo|"
                     r"does not exist|doesn't exist|neither exists|"
                     r"would sensibly be called|invented path|"
                     r"we can lift|if these labels diverge|in the future|"
                     r"used to|there is no|there never has been|the alternative|"
                     r"copied from|handoff|was removed|until 1?\d sep|until 1?\d aug|"
                     r"error ts\d|not found|\.next/types|"
                     r"usage:|example:|for example", low):
            continue

        for fm in FILEREF.finditer(block):
            ref = fm.group(1)
            if NOT_A_FILE.match(ref):
                continue
            """Only a PATH counts as a file citation.

               This codebase cites files the way it cites `lib/portal/session.ts`
               or `src/app/(app)/leads/page.tsx` — with a directory. A bare
               `foo.json` in prose is almost never a file here: measured 12 Sep
               2026, the bare names were ResellerClub API endpoints
               (`signup.json`, `orderid.json`), `NextResponse.json` (a method),
               and usage examples in script docstrings (`path-to.sql`,
               `test.sql`). Requiring a directory took 28 candidates to a
               handful, which is the difference between a check that gets read
               and one that gets skimmed. """
            if "/" not in ref:
                continue
            # an endpoint path, not a repo path
            if ref.endswith(".json") and not ref.startswith(("src/", "scripts/", "supabase/", "tests/", "e2e/")):
                continue
            # try it as given, and relative to src/ and the repo root
            cands = [ref, f"src/{ref}", f"production/{ref}"]
            # a bare name like "provision.ts" — search anywhere
            found = any(os.path.exists(c) for c in cands) or bool(
                glob.glob(f"**/{os.path.basename(ref)}", recursive=True))
            if not found:
                missing_files.append((f, line_no, ref))

        for im in IDENT.finditer(block):
            name = im.group(1) or im.group(2)
            if EXTERNAL.match(name):
                continue
            if not re.search(rf"\b{re.escape(name)}\b", HAYSTACK):
                missing_idents.append((f, line_no, name))

def show(title, rows):
    print(f"\n{title}: {len(rows)}")
    seen = set()
    for f, line, what in rows:
        key = (f, what)
        if key in seen:
            continue
        seen.add(key)
        print(f"  {f.replace(os.sep, '/')}:{line}  ->  {what}")

print(f"scanned {len(files)} files")
show("comments naming a FILE that does not exist", missing_files)
show("comments naming an IDENTIFIER that exists nowhere", missing_idents)
print("\nBoth lists are candidates. A comment may name a deleted thing while")
print("explaining its deletion — read the line before changing it.")
