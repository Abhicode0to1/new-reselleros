"""
A THEME TOKEN, FROZEN INTO A LITERAL.

Written 14 Sep 2026, after the public workspace purchase page was found to be
nearly blank in dark mode. Its hero carried:

    background: linear-gradient(180deg, rgba(250,248,242,1) 0%, ...)

rgba(250,248,242) is #FAF8F2, which IS `--paper` in the LIGHT theme. The literal
cannot flip, so the hero stayed near-white while the text on it — real tokens —
turned cream. Measured: "Indian SMEs" at 1.01:1 on the page that asks for money.

Three more literals on the same page were the same mistake: #1A1815 is `--ink`
light, #DC2626 is `--rose` light.

WHY NO EXISTING SWEEP SAW IT
The §5 checks grep for Tailwind CLASS names (bg-white, text-rose-600). Every one
of these was an inline `style={{}}` literal, so the class count was identical
before and after the fix while the page went from unreadable to clean.

⚠️ EXACT MATCHING DOES NOT WORK, AND THE FIRST VERSION OF THIS SCRIPT USED IT.
It found 3 plausible candidates and MISSED all four defects it was written for.
The reason: the literals are hand-written approximations of the HSL tokens.

    --ink:   24 13% 9%   computes to rgb(26, 22, 20)
    the literal in the page was #1A1815 = rgb(26, 24, 21)

Two channels off by 2 and 1 — the same colour to any eye, and invisible to ==.
--paper was off by 1 and 3 the same way, and #DC2626 is 7 off --rose.

A FLAT TOLERANCE CANNOT WORK EITHER, and this was measured rather than guessed:
the closest two DISTINCT tokens in this palette are 7 apart (--amber-soft vs
--rose-soft, and --rose-active vs --rose-ink). So any flat threshold big enough
to catch #DC2626 is also big enough to confuse two real tokens.

The match is therefore NEAREST-NEIGHBOUR with a margin: find the closest token,
accept it only within REACH, and name every token within MARGIN of that closest
one — so an ambiguous literal reports both candidates instead of picking one and
sounding certain.

Proven by mutation: putting the four frozen gradients back makes this script
report them by name, and it reports none of them under exact matching.

WHAT THIS FLAGS, AND WHAT IT DOES NOT
Only a literal that EQUALS a token's light value AND whose token actually
differs in the dark theme. That pairing is what makes it a bug: the same colour
written two ways, one of which follows the theme and one of which cannot.

  - A token identical in both themes (--whatsapp) is skipped: freezing it is
    harmless, because there is nothing to flip.
  - A brand colour that matches nothing (#4285F4, #FCD34D) is not flagged. Those
    are somebody else's colours and must not be themed.
  - PDF templates are skipped by path: a PDF has no dark mode, and its colours
    are print colours.

So a hit is not automatically a defect — a fixed surface deliberately painted
--ink's light value is legitimate IF its foreground is fixed too. Read the line.
That is why this prints candidates and a count, like its three siblings.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "src", "app", "globals.css")
SRC = os.path.join(ROOT, "src")

# A PDF has no theme. Nor does an OG image.
SKIP_PARTS = (os.sep + "pdf" + os.sep, os.sep + "opengraph", os.sep + "icon")


def hsl_to_rgb(h, s, l):
    """CSS hsl() -> (r, g, b), each 0-255. s and l are percentages."""
    s /= 100.0
    l /= 100.0
    c = (1 - abs(2 * l - 1)) * s
    hp = (h % 360) / 60.0
    x = c * (1 - abs(hp % 2 - 1))
    if   hp < 1: rgb = (c, x, 0)
    elif hp < 2: rgb = (x, c, 0)
    elif hp < 3: rgb = (0, c, x)
    elif hp < 4: rgb = (0, x, c)
    elif hp < 5: rgb = (x, 0, c)
    else:        rgb = (c, 0, x)
    m = l - c / 2
    return tuple(int(round((v + m) * 255)) for v in rgb)


TOKEN_RE = re.compile(r"--([a-z0-9-]+):\s*([0-9.]+)\s+([0-9.]+)%\s+([0-9.]+)%")


def read_tokens():
    """{token: (light_rgb, dark_rgb)} for every token declared in both blocks."""
    css = open(CSS, encoding="utf-8").read()
    root_at = css.index(":root {")
    dark_at = css.index(".dark {")
    light, dark = {}, {}
    for block, out in ((css[root_at:dark_at], light), (css[dark_at:], dark)):
        for m in TOKEN_RE.finditer(block):
            name, h, s, l = m.group(1), float(m.group(2)), float(m.group(3)), float(m.group(4))
            out.setdefault(name, hsl_to_rgb(h, s, l))
    return {k: (light[k], dark[k]) for k in light if k in dark}


LITERAL_RE = re.compile(
    r"#([0-9a-fA-F]{6})\b"
    r"|rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})"
)


def literal_rgb(m):
    if m.group(1):
        h = m.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    return (int(m.group(2)), int(m.group(3)), int(m.group(4)))


def strip_comments(text):
    """Blank comments, keep newlines — a colour named in prose is not code."""
    out, i, n, in_block = [], 0, len(text), False
    while i < n:
        if in_block:
            j = text.find("*/", i)
            if j == -1:
                out.append(re.sub(r"[^\n]", " ", text[i:])); break
            out.append(re.sub(r"[^\n]", " ", text[i:j + 2])); i = j + 2; in_block = False
        else:
            b, s = text.find("/*", i), text.find("//", i)
            nl = text.find("\n", i)
            if s != -1 and (b == -1 or s < b) and (nl == -1 or s < nl):
                out.append(text[i:s]); i = nl if nl != -1 else n
            elif b != -1:
                out.append(text[i:b]); i = b + 2; in_block = True
            else:
                out.append(text[i:]); break
    return "".join(out)


def main():
    tokens = read_tokens()
    # Only tokens that CHANGE between themes can be "frozen" into a bug.
    changing = {k: v for k, v in tokens.items() if v[0] != v[1]}
    same_in_both = sorted(k for k, v in tokens.items() if v[0] == v[1])

    # Pure white and pure black are nobody's colour in particular. Several
    # foreground tokens are literally 0 0% 100% in the light theme, so matching
    # #FFFFFF would attribute it to whichever one the dict happened to keep —
    # a confident, arbitrary, wrong answer. The bug this script exists for is a
    # DISTINCTIVE token value frozen (#FAF8F2, #1A1815, #DC2626), and those are
    # unambiguous.
    GENERIC = {(255, 255, 255), (0, 0, 0)}

    REACH  = 7   # measured: the furthest real case (#DC2626 vs --rose) is 7, and 7 is
                 # also where two DISTINCT tokens first collide (--amber-soft vs
                 # --rose-soft), so it is both the smallest useful and largest safe value.
    TIGHT  = 3   # at or under this a literal IS the token, in all but spelling
    MARGIN = 2    # name every token this close to the nearest, rather than guess

    candidates = [(rgb, name) for name, (rgb, _d) in changing.items() if rgb not in GENERIC]

    def dist(a, b):
        return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))

    def match(lit):
        """The nearest token's light value, if the literal is close enough."""
        scored = sorted((dist(lit, rgb), name) for rgb, name in candidates)
        if not scored or scored[0][0] > REACH:
            return None
        best = scored[0][0]
        hits = sorted({name for d, name in scored if d <= best + MARGIN})
        return "/".join(hits), best

    files = []
    for base, _dirs, names in os.walk(SRC):
        for nm in names:
            if not nm.endswith((".tsx", ".ts")) or ".test." in nm:
                continue
            p = os.path.join(base, nm)
            if any(part in p for part in SKIP_PARTS):
                continue
            files.append(p)

    rows = []
    for p in sorted(files):
        try:
            text = strip_comments(open(p, encoding="utf-8").read())
        except OSError:
            continue
        for i, line in enumerate(text.split("\n"), 1):
            for m in LITERAL_RE.finditer(line):
                hit = match(literal_rgb(m))
                if hit:
                    rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
                    rows.append((rel, i, m.group(0), hit[0], hit[1]))

    print(f"tokens read: {len(tokens)} · change between themes: {len(changing)} "
          f"· distinctive enough to match: {len(candidates)} "
          f"· identical in both (never a finding): {len(same_in_both)} "
          f"· reach {REACH}, margin {MARGIN}")
    print(f"scanned {len(files)} files\n")
    tight = [r for r in rows if r[4] <= TIGHT]
    loose = [r for r in rows if r[4] > TIGHT]

    def show(title, group):
        print(f"{title}: {len(group)}")
        for rel, i, lit, tok, d in group:
            exact = "exactly" if d == 0 else f"within {d}"
            print(f"  {rel}:{i}  {lit}  is {exact} --{tok} (light)")

    show(f"NEAR-EXACT (<= {TIGHT}) — the same colour, written so it cannot flip", tight)
    print()
    show(f"LOOSER ({TIGHT + 1}-{REACH}) — probably the token, hand-rounded", loose)
    print("\nCandidates, not verdicts. A fixed surface may paint --ink's light value")
    print("on purpose — that is correct ONLY if its foreground is fixed too.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
