/**
 * POST /api/ai/generate-assessment
 *
 * Generates reasoning MCQs with Gemini for an employee test. Auth required
 * (owner/manager). If no Gemini key is configured, returns a small built-in
 * sample set so the feature still works (stub mode).
 *
 * Body: { topic?: string, difficulty?: "easy"|"medium"|"hard", count?: number }
 * Returns: { questions: [{ q, options[], correct }], mode }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import type { AssessmentQuestion } from "@/lib/assessments/grade";

const bodySchema = z.object({
  topic: z.string().max(120).optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  count: z.number().int().min(3).max(25).optional(),
  language: z.enum(["en", "hi", "both"]).optional(),
});

const SAMPLE: AssessmentQuestion[] = [
  { q: "If all Bloops are Razzies and all Razzies are Lazzies, then all Bloops are definitely Lazzies.", options: ["True", "False", "Cannot say", "None"], correct: 0,
    q_hi: "Agar saare Bloops, Razzies hain aur saare Razzies, Lazzies hain — to saare Bloops zaroor Lazzies honge.", options_hi: ["Sahi", "Galat", "Keh nahi sakte", "Koi nahi"] },
  { q: "Find the next number: 2, 6, 12, 20, 30, ?", options: ["36", "40", "42", "44"], correct: 2,
    q_hi: "Agla number batao: 2, 6, 12, 20, 30, ?", options_hi: ["36", "40", "42", "44"] },
  { q: "Pointing to a photo, Ravi said, 'She is the daughter of my grandfather's only son.' Who is she to Ravi?", options: ["Sister", "Mother", "Aunt", "Cousin"], correct: 0,
    q_hi: "Ek photo dikhate hue Ravi ne kaha, 'Wo mere dada ke iklaute bete ki beti hai.' Wo Ravi ki kya lagti hai?", options_hi: ["Behen", "Maa", "Bua", "Cousin"] },
  { q: "Which one does NOT belong: Rose, Lotus, Lily, Mango?", options: ["Rose", "Lotus", "Lily", "Mango"], correct: 3,
    q_hi: "Inme se kaun alag hai: Gulab, Kamal, Lily, Aam?", options_hi: ["Gulab", "Kamal", "Lily", "Aam"] },
  { q: "A is taller than B, B is taller than C. Who is the shortest?", options: ["A", "B", "C", "Cannot say"], correct: 2,
    q_hi: "A, B se lamba hai; B, C se lamba hai. Sabse chhota kaun hai?", options_hi: ["A", "B", "C", "Keh nahi sakte"] },
];

function buildPrompt(topic: string, difficulty: string, count: number, language: string): string {
  const focus = topic
    ? `Focus area: ${topic}. `
    : "Mix logical reasoning, number series, verbal reasoning and basic aptitude. ";
  const base =
    `Generate ${count} multiple-choice REASONING/aptitude questions for an employee test. ` +
    `Difficulty: ${difficulty}. ${focus}` +
    `Each question has exactly 4 options and one correct answer. "correct" is the 0-based index of the right option. ` +
    `Keep questions self-contained and unambiguous. Return ONLY a JSON array, no prose.\n`;
  if (language === "both") {
    return base +
      `Every question must be BILINGUAL: give both an English version AND a natural Hinglish version ` +
      `(Hindi written in Roman/English script, the way Indians casually type — NOT pure Hindi Devanagari, NOT formal). ` +
      `The Hinglish options must line up 1:1 with the English options in the same order (same correct index).\n` +
      `[{ "q": "english question", "options": ["a","b","c","d"], "correct": 0, "q_hi": "hinglish question", "options_hi": ["a","b","c","d"] }]`;
  }
  if (language === "hi") {
    return base +
      `Write every question and option in natural Hinglish (Hindi in Roman/English script, the way Indians casually type — NOT Devanagari, NOT formal).\n` +
      `[{ "q": "hinglish question", "options": ["a","b","c","d"], "correct": 0 }]`;
  }
  return base + `[{ "q": "question text", "options": ["a","b","c","d"], "correct": 0 }]`;
}

async function genWithGemini(apiKey: string, model: string, prompt: string): Promise<AssessmentQuestion[] | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const arr = JSON.parse(cleaned) as AssessmentQuestion[];
    if (!Array.isArray(arr)) return null;
    // Sanitise: keep only well-formed MCQs with a valid correct index.
    return arr
      .filter((x) => x && typeof x.q === "string" && Array.isArray(x.options) && x.options.length >= 2)
      .map((x) => {
        const options = x.options.slice(0, 5).map((o) => String(o));
        const out: AssessmentQuestion = {
          q: String(x.q),
          options,
          correct: Math.max(0, Math.min(options.length - 1, Number(x.correct) || 0)),
        };
        // Carry the Hinglish version through only when it lines up with the options.
        if (typeof x.q_hi === "string" && Array.isArray(x.options_hi) && x.options_hi.length === options.length) {
          out.q_hi = String(x.q_hi);
          out.options_hi = x.options_hi.map((o) => String(o));
        }
        return out;
      });
  } catch (err) {
    console.error("[ai/generate-assessment] Gemini crashed:", err);
    return null;
  }
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body;
  try { body = bodySchema.parse(await request.json()); }
  catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }

  const count = body.count ?? 8;
  const difficulty = body.difficulty ?? "medium";
  const topic = body.topic?.trim() ?? "";
  const language = body.language ?? "en";

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const gemini = await resolveGeminiConfig(supabase, me?.tenant_id ?? null);

  if (gemini.apiKey) {
    const q = await genWithGemini(gemini.apiKey, gemini.model, buildPrompt(topic, difficulty, count, language));
    if (q && q.length > 0) return NextResponse.json({ questions: q.slice(0, count), mode: "gemini" });
  }
  // Stub fallback — sample reasoning set so the test still works without a key.
  // For English-only, drop the Hinglish fields so the preview stays clean.
  const sample = SAMPLE.slice(0, Math.min(count, SAMPLE.length)).map((s) =>
    language === "en" ? { q: s.q, options: s.options, correct: s.correct }
    : language === "hi" ? { q: s.q_hi ?? s.q, options: s.options_hi ?? s.options, correct: s.correct }
    : s,
  );
  return NextResponse.json({ questions: sample, mode: "stub" });
}
