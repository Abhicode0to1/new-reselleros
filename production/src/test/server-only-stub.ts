/**
 * `server-only` ka test-time khaali badal.
 *
 * Wo package apne aap me kuch karta nahi — uska kaam BUILD par hai: agar koi server wali
 * file galti se client bundle me kheench li jaye, to build fail ho jaye. Uske `exports` me
 * `react-server` condition hai, jise Vitest resolve nahi kar pata, aur import karte hi
 * "Failed to load url server-only" aa jata hai.
 *
 * Do raaste the. Dusra tha `import "server-only"` hata dena — par wo ek asli suraksha hai
 * (gmail-read.ts mailbox padhta hai; wo kabhi browser me nahi jana chahiye), aur use test
 * chalane ke liye hatana ulta hai: pehre ko test ke liye nahi girate.
 *
 * Isliye vitest.config.ts me ye alias hai. Guard build me poora bana rehta hai.
 */
export {};
