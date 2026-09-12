"""Find every event handler whose ENTIRE body is toast calls.

    cd production && python scripts/find-fake-actions.py

A control that only toasts performs nothing, and when the toast is
`toast.success` it states that work was done. That is worse than a missing
feature: an operator told "Conversion quote sent" stops chasing the customer.

Grep cannot find these. A handler that does real work and THEN toasts matches
any pattern looking for a toast inside a handler, so grep reports the honest
ones alongside the fake. This walks the braces and asks whether anything
survives once every toast call is removed.

Written 12 Sep 2026 after /online-orders was found with 13 of them and zero
database writes, four announcing success. The same pass then found three more:
a "Push Wholesale Rates" button on /partners, a "Nudge expiring quotes" on
/quotes, and a "Setup" on /settings.

EXPECTED OUTPUT: exactly one finding — enquiries/page.tsx's
`toast.error("No phone number in this enquiry.")`, which is correct. It
explains why nothing happened and what to do about it; a handler that refuses
IS doing its job. Anything else in this list is a control making a promise.
"""
import io, os, re, glob

os.chdir("C:/xampp/htdocs/anutechbilling/production")

ROOTS = ["src/app/(app)", "src/app/(public)", "src/components", "src/site"]
files = []
for r in ROOTS:
    files += glob.glob(os.path.join(r, "**", "*.tsx"), recursive=True)

HANDLER = re.compile(r"on(?:Click|Select|Submit|Change)=\{")

def body_after(src, i):
    """Return the text of the {...} that starts at index i (i points at '{')."""
    depth, j = 0, i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1 : j]
        j += 1
    return ""

# things that constitute doing something real
REAL = re.compile(
    r"\b(fetch|mutate|mutateAsync|refetch|router\.|window\.location|window\.open|"
    r"navigator\.clipboard|localStorage|sessionStorage|set[A-Z]\w*|"
    r"\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(|void \w+\(|await |"
    r"open[A-Z]\w*|close[A-Z]\w*|on[A-Z]\w*\(|print\(|submit)"
)

findings = []
for f in sorted(set(files)):
    src = io.open(f, encoding="utf-8").read()
    for m in HANDLER.finditer(src):
        start = src.index("{", m.end() - 1)
        body = body_after(src, start)
        if "toast." not in body:
            continue
        stripped = body.strip()
        # arrow wrapper: () => { ... }  or  () => toast...(...)
        inner = re.sub(r"^\(?\)?\s*=>\s*", "", stripped).strip()
        inner = re.sub(r"^async\s*\(?\)?\s*=>\s*", "", inner).strip()
        if inner.startswith("{") and inner.endswith("}"):
            inner = inner[1:-1]
        if REAL.search(inner):
            continue  # does real work too
        # strip every toast.*(...) call and see whether anything is left
        rest = re.sub(r"toast\.\w+\([\s\S]*?\)\s*;?", "", inner).strip(" ;\n\t")
        if rest:
            continue
        line = src[:start].count("\n") + 1
        msg = re.search(r"toast\.(\w+)\(\s*[`\"']([^`\"']{0,90})", inner)
        findings.append((f.replace("\\", "/"), line,
                         msg.group(1) if msg else "?",
                         msg.group(2) if msg else inner[:70].replace("\n", " ")))

print(f"handlers that do NOTHING but toast: {len(findings)}\n")
for f, line, kind, msg in findings:
    flag = "  <-- CLAIMS SUCCESS" if kind == "success" else ""
    print(f"  {f}:{line}\n      toast.{kind}  \"{msg}\"{flag}")
