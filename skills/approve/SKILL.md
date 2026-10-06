---
name: approve
description: When Foundry gate denies a command, tell the user to approve that exact command in Foundry Wallet and then retry it unchanged. When it says the command is in a form it cannot check, rerun it as the plain command.
---

When a hook deny reason says a command needs approval in Foundry Wallet and includes a hash:

- Stop proposing a different command, remote, or flags. A different command is a new approval.
- Tell the user the command that was denied and the hash from the deny reason.
- Tell them to approve that command in Foundry Wallet, then wait until they say it is approved.
- Retry the identical command, from the same directory, only after they confirm the Wallet approval. Do not make a commit in between: a new commit needs a new approval.
- If the reason says the approval expired, was already used, or was rejected, tell the user a new request is needed and repeat the steps above.

When the deny reason says the command mentions a gated command in a form the gate cannot check:

- Run the gated command on its own, as a plain command, so it can be approved. Do not wrap it in `bash -c`, `env`, `timeout`, a script, an alias or an API call.
- If the command does not actually run the gated command, rewrite it so those words do not appear together, or ask the user.
