// Entry point for the hook. It runs the gate unconditionally, so the check
// cannot be skipped by the path it was started from (a symlinked home, macOS
// /tmp). Anything that stops the gate from loading, such as a Node.js too old
// for its syntax, exits 2 so the command is blocked instead of let through.

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(
    `Foundry gate: Node.js ${process.versions.node} is too old (22 or newer is supported). The command was blocked.\n`,
  );
  process.exit(2);
}

import("./foundry-gate.mjs")
  .then((gate) => gate.main())
  .catch((err) => {
    process.stderr.write(`Foundry gate: ${err && err.message ? err.message : err}. The command was blocked.\n`);
    process.exit(2);
  });
