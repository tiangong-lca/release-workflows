// Consume every listing chunk while retaining only one bounded member name.
// Diagnostic stdout tails must never be used as a complete archive catalog.
export async function inspectZipMembers(archive, spawnCommand) {
  let pending = "",
    memberCount = 0,
    valid = true,
    streamed = false;
  const line = (value) => {
    const member = value.endsWith("\r") ? value.slice(0, -1) : value;
    memberCount++;
    if (
      !member ||
      member.length > 65535 ||
      memberCount > 2_000_000 ||
      /^[\\/]/u.test(member) ||
      /^[a-z]:/iu.test(member) ||
      /[\x00-\x1f\x7f]/u.test(member) ||
      member.split(/[\\/]/u).includes("..")
    )
      valid = false;
  };
  const consume = (chunk) => {
    if (!valid) return;
    const parts = (pending + chunk).split("\n");
    pending = parts.pop();
    for (const part of parts) line(part);
    if (pending.length > 65535) {
      valid = false;
      pending = "";
    }
  };
  const result = await spawnCommand("unzip", ["-Z1", archive], {
    onStdout: (chunk) => {
      streamed = true;
      consume(chunk);
    },
  });
  // Injectable command runners may return a complete response instead of chunks.
  if (!streamed) {
    if (result.stdoutTruncated) valid = false;
    else consume(result.stdout);
  }
  if (pending) line(pending);
  return {
    code: result.code,
    stderr: result.stderr,
    memberCount,
    valid: valid && memberCount > 0,
  };
}
