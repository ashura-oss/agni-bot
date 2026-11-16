import type { Migration } from "../migrations";
import { migration as m60 } from "./m60";
import { migration as m61 } from "./m61";
import { migration as m62 } from "./m62";
import { migration as m63 } from "./m63";
import { migration as m64 } from "./m64";

/** Sprint 3 migrations, ids 60..64. A null slot is reserved and not yet written. */
export const S3_MIGRATIONS: Array<Migration | null> = [m60, m61, m62, m63, m64];
