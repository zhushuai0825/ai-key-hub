# Design Tools (vendor)

Anti-AI-slop UI tooling installed for Cursor agent guidance.

## Installed

| Package | Source | Location |
|---------|--------|----------|
| no-slop-ui | [LeoStehlik/no-slop-ui](https://github.com/LeoStehlik/no-slop-ui) | `vendor/no-slop-ui/` |
| Linear DESIGN.md (reference) | [nexu-io/open-design](https://github.com/nexu-io/open-design) | `vendor/open-design/design-systems/linear-app/` |

## Cursor integration

- `.cursor/rules/frontend-no-slop.mdc` — anti-slop rules for `*.html`, `*.css`, `*.js`
- `.cursor/rules/design-system.mdc` — project design contract
- `DESIGN.md` — canonical design system for this repo

## Update / full clone

If GitHub is reachable, run:

```bash
bash scripts/setup-design-tools.sh
```

This pulls full repos into `vendor/` via git clone (shallow).

## Optional additions

```bash
# hallmark (57 slop-test gates, 20 themes)
git clone --depth 1 https://github.com/Nutlope/hallmark.git vendor/hallmark

# open-design full design systems library
git clone --depth 1 --filter=blob:none --sparse https://github.com/nexu-io/open-design.git vendor/open-design-full
cd vendor/open-design-full && git sparse-checkout set design-systems
```
