// npm run reset: the stage customer's trip back to LK 412 (delayed), v1, no texts, both fixes OFF.
import { reset } from "./store.js";

const t = reset(process.argv[2] ?? "stage");
console.log(`Reset ${t.customer}: LK 412 delayed, ${t.token}, no texts, line off, guard off.`);
