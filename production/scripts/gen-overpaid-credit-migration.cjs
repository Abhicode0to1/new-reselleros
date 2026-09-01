/**
 * record_payment me overpayment-credit jodne wali migration BANATA hai —
 * live function ke pg_get_functiondef par teen surgical edits (audit A5).
 * Haath se 515-line function dobara type karna hi wo galti hai jisse
 * 22 Aug ko 3 guard gum hue the — isliye source LIVE body hai.
 */
const fs = require("fs");
const path = require("path");

const livePath = process.argv[2];
const outPath = process.argv[3];
let body = fs.readFileSync(livePath, "utf8").replace(/\r\n/g, "\n");

function mustReplace(name, from, to) {
  if (!body.includes(from)) {
    console.error("ANCHOR MISSING:", name);
    process.exit(1);
  }
  const before = body.length;
  body = body.replace(from, to);
  if (body.length === before && from !== to) {
    console.error("REPLACE NO-OP:", name);
    process.exit(1);
  }
}

// 1. declare
mustReplace(
  "declare",
  "  v_outstanding           integer;",
  "  v_outstanding           integer;\n  v_overpaid_credit       integer := 0;",
);

// 2. credit block just before the FINAL return (unique by payment_id-first shape)
const finalReturn = "  return jsonb_build_object(\n    'payment_id', v_payment_id,";
mustReplace(
  "final-return block",
  finalReturn,
  `  /* ─── Overpayment → customer credit, ISI transaction me (audit A5, 1 Sep 2026) ───
     Outstanding upar 0 par floor hota hai, to expected se zyada aaya paisa yahan
     record na ho to KAHIN record nahi hota. Ye insert pehle client-side tha
     (record-payment-dialog.tsx), RPC ke commit ke BAAD — network/RLS ki ek hichki
     aur customer ka extra rupaya hamesha ke liye be-hisaab. Incremental hi jodta
     hai (is payment ne jitna naya excess banaya), taki kai kishton me double na gine —
     wahi ganit jo client me tha. */
  v_overpaid_credit := greatest(0, v_total_received - v_expected)
                     - greatest(0, v_prior_received - v_expected);
  if v_overpaid_credit > 0 and v_customer_id is not null then
    insert into public.customer_credits
      (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
    values
      (v_tenant_id, v_customer_id, v_overpaid_credit, 'overpayment', v_payment_id, p_quote_id,
       'Excess over quote ' || p_quote_id, 'open');
  end if;

${finalReturn}`,
);

// 3. return field
mustReplace(
  "return field",
  "    'idempotent_replay', false\n  );",
  "    'overpaid_credit', v_overpaid_credit,\n    'idempotent_replay', false\n  );",
);

const header = `-- record_payment: overpayment ka credit ab ISI transaction me banta hai.
--
-- 1 Sep 2026 ke audit ka A5. RPC outstanding ko 0 par floor karta hai, aur
-- excess ka customer_credits insert CLIENT me tha — RPC commit ke baad, sirf
-- console.error ke sahare. Tab close/network/RLS — aur paisa mila hua par
-- be-hisaab. Ab wahi incremental-excess ganit function ke andar hai, aur
-- return me 'overpaid_credit' aata hai jise dialog seedha dikhata hai.
--
-- Body ka source: LIVE pg_get_functiondef (1 Sep 2026) + teen surgical edits
-- (scripts/gen-overpaid-credit-migration.cjs) — haath se retype nahi, kyunki
-- wahi raasta 22 Aug ko 3 guard kha gaya tha.

`;

fs.writeFileSync(outPath, header + body + ";\n");
console.log("written", outPath, body.length + header.length, "chars");
