import type { Migration } from "../migrations";
import { migration as m54 } from "./m54";
import { migration as m55 } from "./m55";
import { migration as m56 } from "./m56";
import { migration as m57 } from "./m57";
import { migration as m58 } from "./m58";
import { migration as m59 } from "./m59";

/** Sprint 2 migrations, ids 54..59. A null slot is reserved and not yet written. */
export const S2_MIGRATIONS: Array<Migration | null> = [m54, m55, m56, m57, m58, m59];
