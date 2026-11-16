// Test-only: `bun --preload` this file to give the real entry point a command that exists
// only in an extra table. Nothing in src/ loads it.
import { registerCommandTable } from "../src/cli/extra-commands";

registerCommandTable({
  commands: {
    "p0-extra-probe": (args) => {
      console.log(`p0-extra-probe ran with ${JSON.stringify(args)}`);
    },
  },
  help: ["  p0-extra-probe     test-only command"],
});
