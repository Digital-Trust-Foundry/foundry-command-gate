# Foundry Command Gate

A Claude Code plugin from Digital Trust Foundry. It stops the shell commands your organization names, such as `git push`, `gh pr merge` or a deploy, until an officer of the company signs that exact command in Foundry Wallet. That command then runs once. A different command, a different directory or a new commit needs a new approval. If Foundry cannot be reached, the command does not run.

Every approval is a signed record on your Foundry tenant. An auditor can verify who signed which command, and when, after the chat is gone.

A Foundry tenant is required. An administrator of that tenant adds the officer as a user, and the officer initializes Foundry Wallet, before any command can be signed. To request a tenant, email info@digitaltrustfoundry.com with the enterprise making the request, a contact, and the use case. Once that Wallet exists, [Try the Foundry Command Gate](docs/try-it.md) walks through a push on a local repository.

## What it is, and what it is not

The gate checks the commands Claude runs through its Bash and PowerShell tools. It reads each command before it runs and asks for a signature when the command is one you named. When a command names a gated command in a form the gate cannot read, such as `bash -c "git push"`, a wrapper like `timeout` or `env`, or an API call that merges a pull request, the gate refuses it and asks Claude to run the plain command instead. No Wallet request is opened for those.

It is not a sandbox. It cannot see a git alias defined in your git config, low-level git commands such as `git send-pack`, a direct call to the GitHub API with `curl`, or a script that pushes on your behalf. Keep branch protection on the repositories that matter. For a setup that users and Claude cannot switch off, see [For administrators](#for-administrators).

## Requirements

* A Foundry tenant and a tenant API key that can create and read trustables.
* Node.js 22 or newer on `PATH`. Claude Code itself does not need Node.js, so install it if it is missing. Without it, gated commands are blocked.
* macOS, Linux, or Windows with Git for Windows (Git Bash).

## Install

```bash
claude plugin marketplace add Digital-Trust-Foundry/foundry-command-gate
claude plugin install foundry-gate@foundry-command-gate
```

Claude Code then asks for four settings. You can change them later with `/plugin`.

| Setting | What to enter |
| --- | --- |
| Foundry endpoint | The address of your tenant, for example `https://yourcompany.digitaltrustfoundry.com` |
| API key | A tenant API key. Claude Code keeps it in the system keychain. |
| Signing file | The JSON file described below |
| Gated commands | Commands that need a signature, separated by commas. The default is `git push, gh pr merge`. |

Restart Claude Code after changing a setting.

### The signing file

The signing file names the request schema registered on your tenant and who signs. Keep it where only you, or your administrator, can write it. The gate refuses a file that other users can write.

```json
{
  "schema": { "id": "claude_command_approval", "version": "1.0.0" },
  "signingAuthority": {
    "legal_entity": { "lei": "549300EXAMPLE000000" },
    "representative": {
      "actor_aid": "E...",
      "display_name": "Release owner",
      "role": { "scheme": "GLEIF:vLEI", "oor_role_code": "ROLE" }
    },
    "authority_credentials": []
  },
  "signaturePolicy": {
    "threshold": 1,
    "required_roles": [],
    "candidates": [{ "actor_aid": "E...", "display_name": "Release owner" }]
  }
}
```

Name more candidates and raise `threshold` when a command needs more than one officer. Name only people who sign in Foundry Wallet: an approval signed by a custodial signer, which signs on the server by itself, is refused.

## How an approval works

1. Claude runs a gated command. The gate stops it and opens a request in Foundry.
2. The officer sees the request in Foundry Wallet: the command, the working directory, the branch and commit for git commands, and a short hash.
3. The officer approves or rejects it.
4. Claude retries the identical command. The gate checks the signature with Foundry, checks that a person signed it in Foundry Wallet, records a claim on the approval, and lets the command continue to Claude Code's own permission rules. It never grants a command those rules would refuse.
5. The approval is used. The next run of the same command opens a new request.

An approval expires 15 minutes after it is signed. A rejected or expired request opens a new one the next time the command is tried. Single use is enforced in Foundry, so editing files on the machine cannot reuse an approval, and two copies of the command started together run only once.

## Examples

**Approve a push.** Ask Claude to push the current branch. The push is stopped with a message naming the command and its hash. Approve it in Foundry Wallet, tell Claude it is approved, and Claude retries the same push, which then runs.

**Gate deploys as well as pushes.** Set Gated commands to `git push, gh pr merge, npm publish, terraform apply, kubectl`. A name on its own, like `kubectl`, gates every `kubectl` command.

**Roll it out to a team.** An administrator deploys the plugin, the endpoint, the signing file and the command list through managed settings, as shown below, so every developer gets the same gate and cannot turn it off.

## What is sent to Foundry

For each gated command the gate sends your tenant:

* the command, with credentials removed first (a `user:token@` part of a URL and values such as `GH_TOKEN=…` become `***`),
* the working directory,
* the tool name (`Bash` or `PowerShell`),
* for git commands, the current branch and commit,
* the gated command it matched and a hash of the above,
* the schema, signing authority and signature policy from your signing file.

After an approved command runs, it records that it ran. Nothing else from the conversation is sent: not your prompts, not Claude's replies, not file contents. The API key is sent as a bearer token to your tenant and nowhere else. The records are kept on your tenant as signed trustables, and the Wallet shows the request to the officers named in your signing file.

On the machine, the gate keeps a small cache in the plugin's data folder that links each command to its Foundry request. It decides nothing on its own: every check reads the approval from Foundry.

## For administrators

A plugin hook that a user installs can be switched off by that user, and since Claude Code 2.1.287 a mod installed on the same machine can approve a call the gate refused. Deploy the gate through managed settings when it has to hold. Managed settings live in `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS, `/etc/claude-code/managed-settings.json` on Linux and WSL, and `C:\Program Files\ClaudeCode\managed-settings.json` on Windows, or come from your MDM or the claude.ai admin console.

```json
{
  "extraKnownMarketplaces": {
    "foundry-command-gate": {
      "source": { "source": "github", "repo": "Digital-Trust-Foundry/foundry-command-gate" }
    }
  },
  "enabledPlugins": { "foundry-gate@foundry-command-gate": true },
  "pluginConfigs": {
    "foundry-gate@foundry-command-gate": {
      "options": {
        "endpoint": "https://yourcompany.digitaltrustfoundry.com",
        "signing_file": "/Library/Application Support/ClaudeCode/foundry-signing.json",
        "commands": "git push, gh pr merge"
      }
    },
    "cc-plugin-sec-default@builtin": {
      "options": { "allowManagedModsOnly": true }
    }
  },
  "permissions": { "disableBypassPermissionsMode": "disable" },
  "sandbox": { "enabled": true }
}
```

* `enabledPlugins` in managed settings keeps the plugin on whatever a user sets.
* `pluginConfigs` fixes the endpoint, the command list and the path of the signing file. Put the signing file somewhere only administrators can write. Each user still enters their own API key.
* `allowManagedModsOnly` stops mods your users install from loading, so none can approve a command the gate refused.
* Turning off bypass permissions mode keeps Claude Code's own permission checks in place after an approval.
* The sandbox limits what shell commands can write to the project folder, so a command cannot edit the plugin, its cache or your settings.

## Tests

```bash
node --test
```

The tests run against a local stand-in for the Foundry API and do not call a live tenant. CI runs them on macOS, Linux and Windows, and runs `claude plugin validate --strict` on the plugin and the marketplace.

## Licence

See [LICENSE](LICENSE). The bundled Foundry SDK in `scripts/vendor/` is under the Apache License 2.0, included as `scripts/vendor/LICENSE-foundry-sdk.txt`.

Security issues: see [SECURITY.md](SECURITY.md).
