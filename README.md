# Foundry Command Gate

A Claude Code plugin. It stops before a shell command the organization names, and an officer of the company signs that exact command in a Foundry Wallet. A retry of the same command is allowed once. A different command needs a new signature. If Foundry cannot be reached, the command does not run.

The signature remains, and an auditor can verify it after the chat is gone. Use it when that command moves money, changes a live system, or commits the company to someone outside.

A Foundry tenant is required. To talk about that command, email sales@digitaltrustfoundry.com.

The policy that ships names `git push` and `gh pr merge` so the hook can be tried. Replace `policy/default.json`, or set `policy` in the tenant config, with the commands an officer should sign.

## Load it locally

The machine needs Node.js 18 or newer on `PATH`.

```bash
claude --plugin-dir /path/to/foundry-command-gate
```

Write the tenant config yourself. The plugin does not create it, and it must not be committed.

```bash
mkdir -p "$CLAUDE_PLUGIN_DATA"
install -m 0600 /dev/null "$CLAUDE_PLUGIN_DATA/config.json"
```

`CLAUDE_PLUGIN_DATA` is set by Claude Code when the plugin runs. Put this JSON in that `config.json`:

| Field | Purpose |
| --- | --- |
| `endpoint`, `apiKey` | Tenant Trustables API. Sent as `X-API-Key`. |
| `schema` | `{ "id", "version" }` registered on that tenant |
| `signingAuthority` | Legal entity, representative, authority credentials |
| `signaturePolicy` | Threshold and candidate AIDs |
| `policy` | Optional. Omit it to use `policy/default.json` |

A missing or world-readable config blocks a gated command. Commands outside the policy are unchanged.

The officer sees the command in Foundry Wallet and signs it. Signing a different command does not unlock the one that was denied. After the signature, retry the identical command. The next one needs a new signature.

## Tests

```bash
node --test
```

The automated tests use a local HTTP stub. They do not call a live tenant.
