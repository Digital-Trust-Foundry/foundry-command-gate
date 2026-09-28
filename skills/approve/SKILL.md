---
name: approve
description: When Foundry gate denies a command, tell the user to approve that exact command in Foundry Wallet and then retry it unchanged.
---

When a hook deny reason says a command needs Foundry Wallet approval and includes a hash:

- Stop proposing a different command, remote, or flags. A different command is a new approval.
- Tell the user the command that was denied and the hash from the deny reason.
- Tell them to approve that command in Foundry Wallet, then wait until they say it is approved.
- Retry the identical command only after they confirm the Wallet approval.
