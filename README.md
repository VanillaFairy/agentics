# agentics

A Claude Code plugin for workflow-orchestrated design, investigation and development over a
generic codebase. All work is one execution tree: decomposed until atomic, executed by readiness
in framework-owned worktrees, verified and reviewed by rigor, and landed into your branch only on
your go.

The design — the whole system as it is today — is [`docs/DESIGN.md`](docs/DESIGN.md).

## Install

This repository is a single-plugin marketplace: `.claude-plugin/marketplace.json` defines the
`vanillafairy` marketplace, listing exactly one plugin, `agentics`, sourced from the repository
root.

- Register the marketplace:

  ```bash
  /plugin marketplace add VanillaFairy/agentics
  ```

- Install the plugin from it:

  ```bash
  /plugin install agentics@vanillafairy
  ```

To update later, run `/plugin marketplace update vanillafairy`, then reinstall or enable the new
version from `/plugin`.

## Development

Run the checks with:

```bash
node tools/lint.mjs && node --test
```

Validate the manifests with `claude plugin validate .`.

## License

MIT
