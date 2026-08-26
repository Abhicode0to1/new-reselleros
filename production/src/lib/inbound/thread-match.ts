/**
 * Kya ye email us khuli lead ki CHAL RAHI baatcheet ka hissa hai, ya ek naya sauda?
 *
 * ─── YE SAWAAL KYUN PAIDA HUA ───────────────────────────────────────────────
 * 26 Aug 2026, Pardeep: "lekin ek email id se to customer mujhse kai baar quote maang
 * sakta hai kai reseller aise hai jo apne multiple clients ke liye quote maange hai".
 *
 * Wo sahi tha, aur `disposition.ts` ka niyam adhoora tha. Wo kehta tha: bhejne wale ki
 * khuli lead mili to email usi par jodo — **bina shart**. Yaani ek email id se doosra
 * sauda kabhi shuru hi nahi ho sakta tha.
 *
 * Uske apne data me ye ho chuka tha. Do email, 30 minute ke faasle par, dono ek hi lead
 * par jud gaye:
 *
 *     18:08  "20 email of business starter send quote"
 *     18:38  "20 email id google workspace business starter qu..."
 *
 * Dono alag subject, kisi par `Re:` nahi — yaani do naye email the, reply nahi. Aur lead
 * ke seats ek doosre par overwrite hote rahe.
 *
 * ─── PAR PURANA NIYAM BEWAJAH NAHI THA ──────────────────────────────────────
 * Wo 22 Aug ke ek bug se aaya tha: thread ke beech ka reply — "actually I need 20 users
 * of Standard, not 50 of Starter" — classifier ne "nayi enquiry nahi hai" keh kar **Spam
 * me daal diya** tha. Wo thread ka sabse zaroori message tha.
 *
 * Dono baatein sachchi hain, aur wo theek ek jagah takrati hain: jaane-pehchane sender ka
 * email — **jawab hai ya naya thread?** Ye file wahi ek sawaal ka jawab deti hai, aur
 * `disposition.ts` uske aadhar par faisla karti hai. Isse 22 Aug ka bug wapas nahi aata:
 * ek asli reply thread me hota hai, to wo aaj bhi judega aur classifier use grade nahi
 * karega.
 *
 * ─── NAAP, ANDAZA NAHI ──────────────────────────────────────────────────────
 * Faisla email ke apne signal par hota hai, kisi model par nahi:
 *
 *   1. `In-Reply-To` / `References` — RFC 5322 ke headers. Inka hona hi batata hai ki ye
 *      kisi cheez ka jawab hai. Yahi wo tareeka hai jisse har mail client thread banata
 *      hai.
 *   2. Subject par `Re:` / `Fwd:` — jab forwarder headers gira deta hai (aur kai gira dete
 *      hain), tab bhi prefix bacha rehta hai.
 *   3. Subject us lead par pehle se maujood kisi subject se mel khata ho — prefix bhi kho
 *      gaya ho tab ka aakhri sahara.
 *
 * Kuch bhi pata na chale to jawab `undefined` hai, aur uska matlab `disposition.ts` me
 * tay hota hai — dekho wahan `continuesOpenLead` ka comment.
 */
import { normaliseSubject } from "./threads";

/**
 * Subject par `Re:` / `Fwd:` jaisa koi prefix tha?
 *
 * Yahan REPLY_PREFIX ka apna copy JAAN-BOOJHKAR nahi hai. `threads.ts:30` me wo regex
 * pehle se hai par export nahi hui, aur ek regex ke do copy ka matlab hota hai ki ek din
 * ek "Antwort:" pehchane aur doosra nahi. To yahan wahi kaam usi exported function se
 * nikala gaya hai: agar prefix hata kar subject BADAL jata hai, to prefix tha.
 */
export function hadReplyPrefix(subject: string | null | undefined): boolean {
  const raw = (subject ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!raw) return false;
  return normaliseSubject(subject) !== raw;
}

export interface ThreadMatchInput {
  /** `In-Reply-To` header, jaisa aaya. */
  inReplyTo?: string | null;
  /** `References` header, jaisa aaya (kai message-id ho sakte hain). */
  references?: string | null;
  subject?: string | null;
  /**
   * Us khuli lead par pehle se darj subjects. Inhe `normaliseSubject` se guzarna ZAROORI
   * nahi — ye function khud guzarta hai, taaki caller ko yaad rakhna na pade.
   */
  leadSubjects?: readonly (string | null | undefined)[];
}

/**
 * `true` — chal rahi baatcheet ka hissa. `false` — naya thread, yaani naya sauda.
 * `undefined` — pata nahi chala (koi header nahi, koi subject nahi).
 */
export function continuesThread(input: ThreadMatchInput): boolean | undefined {
  /* Header ka HONA hi kaafi hai — uske andar ka id kisi maujood record se milana zaroori
     nahi. Wajah: jab grahak HAMARE bheje hue mail ka jawab deta hai, to wo hamare message
     ka id reference karta hai — aur hum apne bheje gaye mail ka RFC Message-ID kahin
     store nahi karte (`email_log.provider_message_id` provider ka id hai, ye header nahi).
     To "id milta hai kya" poochhne par har asli reply "naya thread" ban jata, jo theek
     ulta jawab hai. */
  const hasHeader = Boolean(
    (input.inReplyTo ?? "").trim() || (input.references ?? "").trim(),
  );
  if (hasHeader) return true;

  if (hadReplyPrefix(input.subject)) return true;

  const subj = normaliseSubject(input.subject);
  if (!subj) return undefined;   // na header, na subject — koi aadhar nahi

  const known = (input.leadSubjects ?? [])
    .map((s) => normaliseSubject(s))
    .filter(Boolean);

  if (known.includes(subj)) return true;

  /* Subject hai, aur wo lead ke kisi purane subject se mel nahi khata, aur uspar koi reply
     prefix bhi nahi. Ye ek naya thread hai — aur yahi Pardeep ka wo maamla hai jisme ek
     reseller apne agle client ke liye alag mail bhejta hai. */
  return false;
}
