# Type scale — proposal

> Likha 25 Aug 2026, `/leads` ke usability audit ke baad. Audit ne **chaar** element flag kiye jo
> 12px se chhote thay. Naapne par nikla ki wo **2,010** hain. Ye document wo naap, uska asli
> kaaran, aur teen option unke daam ke saath rakhta hai.
>
> **Faisla tumhara hai** — main sirf ek recommend kar raha hoon. Step 1 mechanical hai aur
> **kuch bhi nahi badalta**; Step 2 design faisla hai aur layout hilata hai.

---

## 1. Naap — jo hai wahi likha hai

```
NAMED Tailwind sizes ............ 3,301 uses   (text-xs 1381 · text-sm 1172 · baaki 748)
ARBITRARY px sizes .............. 2,305 uses
                                  ─────────
                                  5,606 total  →  41% arbitrary
```

Arbitrary ka poora breakdown:

| Size | Uses | Note |
|---|---|---|
| `text-[11px]` | **1,143** | **poore app ka sabse aam size** |
| `text-[10px]` | **820** | |
| `text-[12px]` | 171 | `text-xs` pehle se yahi hai |
| `text-[13px]` | 99 | `xs`(12) aur `sm`(14) ke beech |
| `text-[9px]` | 47 | |
| `text-[15px]` | 11 | |
| `text-[9.5px]` · `text-[12.5px]` | 3 · 3 | aadha pixel |
| `text-[7px]` | 1 | `accounting/payroll/screens.tsx` |
| ek-ek: 14/16/17/19/22/28/54px | 7 | 54px public buy page ka hero hai |

**Files:** 370 `.tsx` me se **273** me arbitrary size hai — **74%**.

`tailwind.config.ts` me **`fontSize` block hai hi nahi**, to conform karne ke liye koi scale
maujood nahi hai.

---

## 2. Asli kaaran — ye laaparwahi nahi hai

Tailwind ka scale **`text-xs` = 12px par rukta hai.** Uske neeche kuch nahi hai.

Aur is UI ko uske neeche **sach me chahiye**: dense table, chip, count badge, metadata row,
timeline note. **2,010 arbitrary values 12px se neeche hain** — yaani wo **scale ka na hona**
bhar rahe hain, scale ko tod nahi rahe.

To sahi fix **2,010 element ko 12px par uthana nahi** hai. Sahi fix **scale ko neeche badhana aur
jo pehle se hai use naam dena** hai.

---

## 3. 🔴 Ek cheez jo is kaam ko "pure rename" ya "layout change" banati hai

`text-[11px]` sirf `font-size` set karta hai. **Line-height set nahi karta.**
`text-xs` **dono** set karta hai (`font-size: .75rem; line-height: 1rem`).

Naapa:

```
slash syntax (text-[11px]/[14px]) kahin bhi ......... 0 uses
arbitrary size ke saath explicit leading-* ......... 253 uses
arbitrary size jo parent se line-height lete hain .. 2,052 uses
globals.css me global line-height .................. koi nahi
```

**Iska matlab:**

- Naya rung **line-height ke saath** define karo → codemod **2,052 element ka vertical rhythm
  badal dega**, 273 file me. Wo rename nahi, layout change hai.
- Naya rung **sirf `font-size`** se define karo → codemod **saabit taur par no-op** hai.

**Recommendation: sirf `font-size`.** Line-height baad me, jaan-boojh kar, per-component
tighten karna. Ek badlaav me do cheez mat milao.

---

## 4. Teen option, daam ke saath

### Option A — sirf naam do, kuch na badlo ✅ **recommended**

```ts
// tailwind.config.ts
theme: { extend: { fontSize: {
  // font-size ONLY — koi line-height nahi, taaki codemod no-op rahe. §3 dekho.
  "3xs": "0.625rem",   // 10px — 820 uses
  "2xs": "0.6875rem",  // 11px — 1,143 uses
} } }
```

Codemod:
```
text-[11px]   → text-2xs      (1,143)
text-[10px]   → text-3xs        (820)
text-[12px]   → text-xs         (171)   ← pehle se maujood rung
text-[9px]    → text-3xs         (47)   ← 9px koi rung nahi, 10px par uthao
text-[9.5px]  → text-3xs          (3)
text-[7px]    → text-3xs          (1)   ← saaf bug
text-[12.5px] → text-xs           (3)
```

- **Visual badlaav:** sirf 9px/9.5px/7px wale **51 element** (wo bug hain).
- **Baaki 2,254 element:** **bilkul kuch nahi badlega.**
- **Audit finding:** **band nahi hoti** — 11px abhi bhi 11px hai.
- **Daam:** ek config block + ek codemod. **Aaj ho sakta hai.**
- **Faayda:** ab ek scale hai, aur `text-[Npx]` ban kiya ja sakta hai (§5).

### Option B — floor 12px par le jao (audit ka literal ask)

`2xs` = 12px, `3xs` = 11px. Yaani **1,143 element 11→12px** aur **820 element 10→11px**.

- **Visual badlaav:** **1,963 element**, 273 file me.
- **Risk:** chip, count badge aur table cell **chaudi ho jaayengi**. Jahan `truncate` hai wahan
  **aur clip** hoga (jaisa sidebar par abhi hua — 14px chhota tha). Jahan `flex` row hai wahan
  **wrap** ho sakti hai.
- **Iske liye poora visual pass chahiye** — 273 file, `/leads` jaise har dense screen par.
- **Daam:** ek din se zyada, aur **browser me screen-by-screen verify** karna padega.

### Option C — beech ka raasta: floor uthao sirf **body copy** par

Rule: **paragraph aur sentence 12px se neeche nahi**; chip, badge, count, tabular metadata
`2xs`/`3xs` par rah sakte hain.

- Audit ke chaar findings me se **3 sach me body copy hain** (`<p>`, scope note, hint line).
  Wo `text-xs` par jaate hain. **Chaar-panch element, aaj.**
- Chip/badge waise rehte hain.
- **Daam:** Option A + un teen call site ka patch.
- **Kamzori:** "body copy" ki koi mechanical definition nahi hai, to ye **judgement** hai —
  ESLint se enforce nahi hoga.

---

## 5. Jo isse dobara badhne se rokta hai

Naam dene ka poora faayda **tab** hai jab `text-[Npx]` wapas na aa sake:

```js
// eslint.config.mjs — no-restricted-syntax
{
  selector: "Literal[value=/text-\\[\\d+(\\.\\d+)?px\\]/]",
  message:
    "Arbitrary font size. Scale use karo: text-3xs (10px) · text-2xs (11px) · text-xs (12px) · " +
    "text-sm (14px). Naya rung chahiye to tailwind.config.ts me jodo, yahan nahi — " +
    "docs/TYPE-SCALE-PROPOSAL.md dekho.",
}
```

Ye **wahi shape** hai jo CLAUDE.md §5 rang ke liye kehta hai (`bg-paper`, `bg-white` nahi).
`text-[11px]` type ka `bg-white` hai — **aaj tak koi rule nahi tha, isliye 2,305 baar aaya.**

Public buy page ka `text-[54px]` hero **legit exception** hai — usko `// eslint-disable-next-line`
ke saath ek line ka kaaran chahiye, ya `text-6xl` par le jaana chahiye.

---

## 6. Meri sifaarish

**Ab: Option A + §5 ka ESLint rule.**

Wajah: wo **saabit taur par kuch nahi todta** (§3), 51 asli bug theek karta hai, scale bana deta
hai, aur **kal se problem badhna band** ho jaati hai. Ye ek commit hai.

**Uske baad, alag se: Option C.** Audit ki teen body-copy line 12px par lao — wo chhota, dekhne
layak sudhaar hai jo tumhari raay par tikta hai.

**Option B ab nahi.** 1,963 element hilana aaj kiya jaaye to wo **43 commit ke saath deploy hoga
jo abhi tak live nahi gaye**, aur agar kuch bigda to pata nahi chalega ki kis badlaav se. Wo
deploy ke **baad** ka kaam hai, alag se, screen-by-screen verify ke saath.

---

## 7. Jo tumhe tay karna hai

1. **`2xs` = 11px rakhein (A) ya 12px (B)?** — main **11px** kehta hoon, aaj ke liye.
2. **`text-[13px]` (99 uses) ka kya?** — `text-sm` (14px) me milao, ya `13px` ka apna rung
   banao. Main **`text-sm` me milane** ke haq me hoon: ek rung kam, aur badlaav **upar** ki taraf
   hai (padhne me behtar).
3. **`text-[15px]` (11 uses)** — `text-base` (16px) me milao? Wahi tark.
4. **ESLint rule error ya warn?** — main **error** kehta hoon, kyunki warn wale rule log
   padhna band kar dete hain.

Bolo, aur main Option A + ESLint rule ek commit me laga deta hoon — poore gate ke saath, aur
`/leads` par browser me verify karke ki **kuch bhi nahi hila.**
