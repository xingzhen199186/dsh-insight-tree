# DSH Insight Tree

[简体中文 README](README.md)

DSH Insight Tree is an observability and diagnostics plugin for DeepSeek Harness (DSH).
It combines Profile configuration, installed packages, Loader runtime state, session activity,
and upstream release metadata into one explainable report, then presents that report through a
plugin tree, a current-session activity panel, and a standalone diagnostics page.

It is not a plugin marketplace. It answers practical questions:

- What is installed and assembled in the current Profile?
- Did the Loader actually load each plugin, and which Fiber phase is it in?
- Is a plugin compatible with the DSH host and its companion packages?
- Which plugin capabilities were used in the current session?
- If startup fails, can the failure be attributed to a non-core plugin?

You can also manage installed plugins directly from the plugin tree, including disabling,
re-enabling, uninstalling, and updating them.

The plugin includes a standalone diagnostics page. When DSH fails to start and the failure is
identified as plugin-related, the diagnostics page opens automatically. You can also start it
manually. It does not depend on the DSH Web UI or on a running DSH instance: launch it from the
command line to inspect the current DSH and its plugins as a whole, and perform the supported
operations.

<img width="771" height="774" alt="1788829120570" src="https://github.com/user-attachments/assets/dadec849-4722-4b02-927a-12e359b7c2ff" />

## Package Shape

This is a single npm package with five integration surfaces:

- **Host entry**: `lib/index.js` for report generation, routes, Loader/Session integration, and plugin operations.
- **Client bundle**: `lib/client.js`, injected by DSH Web for the plugin tree and current-session activity UI.
- **Standalone diagnostics command**: `dsh-insight-tree-diagnose`, backed by `bin/diagnose.mjs`.
- **Failure-aware web launcher**: `dsh-insight-tree-web`, backed by `bin/web-with-diagnostics.mjs`.
- **DSH assembly declaration**: `cordis.patch.yml`, which connects the plugin to the DSH bundle and Loader chain.

Runtime dependencies include `js-yaml`, `semver`, and `zod`. Loader, Session Projection, and
Session Query integrations are peer dependencies; optional components are detected and the plugin
degrades with an explicit source marker when they are unavailable.

## Installation

### Install from npm

Run this in PowerShell:

```powershell
dsh plugin --profile web add dsh-insight-tree
```

Restart DSH Web after installation so the host, client bundle, and `cordis.patch.yml` assembly are loaded:

```powershell
schtasks /run /tn DSHWebRestart
```

Verify that the package is present in the `web` Profile:

```powershell
dsh --profile web --dump-config
```

After DSH starts, open **Settings -> Plugins -> Plugin Tree**. The **Current Activity** entry is
available inside DSH conversations only.

If pnpm's supply-chain policy rejects a newly published dependency, relax it for this command only:

```powershell
dsh plugin --profile web add dsh-insight-tree --config.minimum-release-age=0
```

### Install from a local checkout

For local development, install the checkout as a link:

```powershell
dsh plugin --profile web add I:\DSH\dsh-insight-tree
```

After rebuilding changed source files, restart DSH Web to load the new `lib/` output.

### Run standalone diagnostics

The npm package includes a standalone diagnostics command. It can run while DSH is running or when DSH is stopped:

```powershell
dsh-insight-tree-diagnose --profile web --port 3092
```

Open `http://127.0.0.1:3092/`. If the command is not available on `PATH`, invoke the package script directly:

```powershell
node node_modules\dsh-insight-tree\bin\diagnose.mjs --profile web --port 3092
```

Normal DSH startup does not open this page automatically. The failure-aware launcher opens it only when
the startup error is explicitly attributable to a non-core plugin:

```powershell
dsh-insight-tree-web --profile web
```

## Design

The core is an evidence aggregation pipeline rather than a single page:

```text
Profile / package.json / node_modules / cordis.patch.yml
                         |
                         v
              DSH Loader / Fiber state
                         |
                         v
            Session Projection / Query
                         |
                         v
                 InsightTreeReport
                   /      |      \
                  v       v       v
             Plugin tree  Activity  Diagnostics
```

All surfaces consume `InsightTreeReport` from `src/model.ts` (schema v3), so the Web UI,
standalone diagnostics, and exports share the same compatibility and severity decisions.

### Observation dimensions

1. **Installation**: Profile `package.json`, actual `node_modules`, and package metadata.
2. **Assembly**: `dsh.profile.bundles` and Loader relationships from `cordis.patch.yml`.
3. **Loading**: Real `ctx.loader` entries and their Fiber phases.
4. **Compatibility**: DSH host, companion DSH packages, and plugin release semver checks.
5. **Usage**: `session/event`, durable projections, and optional historical session queries.
6. **Upstream**: Plugin directory, npm packument, and GitHub metadata, with explicit offline fallback.

The runtime Loader state takes precedence over static declarations. Actual installed versions take
precedence over Profile specs. Missing context is reported as **temporarily unknown**, not as an
automatic incompatibility.

## Compatibility Semantics

The labels **current plugin**, **latest plugin**, and **latest compatible plugin** always refer to the
plugin's own version, not the DSH host version. For example:

```text
Current plugin 2.10.3   npm: dsh-pocket   Latest compatible version
```

The DSH host is shown separately:

```text
Compatible with current DSH host @deepseek-ai/dsh@0.1.2-rc.1
```

Compatibility checks use the dependency type:

- `@deepseek-ai/dsh` or `engines.dsh`: compare with the actual installed DSH host version.
- `@deepseek-ai/dsh-*`: compare with the corresponding companion package installed in the current Profile.
- Missing context or an unparsable range: show `unknown` and explain why it cannot yet be confirmed.

Installing another DSH host version causes the report to recalculate compatibility. The same plugin
release can therefore have different results under different host or companion-package combinations.

## User Interfaces and Boundaries

### Inside DSH

Normal DSH startup does not open the standalone page. Inside DSH, users can open:

- **Plugin Tree**: navigation entry for structure, capabilities, dependencies, compatibility, and Loader state.
- **Current Activity**: plugins used by the current conversation session.

### Standalone diagnostics

The standalone page does not depend on the full DSH Web UI. It reads the Profile, package metadata,
and patch files, and provides reports, exports, and protected configuration operations.

It listens on loopback only. Disable, enable, and uninstall operations back up Profile files, validate
configuration changes with a dry run, and refuse to operate on core `@deepseek-ai/*` packages or targets
with active dependents.

## Source Map

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entry, event statistics, projections, Loader snapshot, and route assembly |
| `src/model.ts` | `InsightTreeReport` and plugin, compatibility, finding, and activity types |
| `src/discovery.ts` | Profile, package metadata, patch, dependency, and report generation |
| `src/loader.ts` | Pure mapping from Loader entries to Fiber phases |
| `src/activity.ts` | Session projection folding and history helpers |
| `src/owners.ts` | Explicit and stable tool-to-plugin ownership mapping |
| `src/upstream.ts` | Plugin directory, npm/GitHub metadata, and version compatibility |
| `src/rules.ts` | Missing-package, duplicate-assembly, compatibility, and startup-impact rules |
| `src/route.ts` | Report, session, export, compare, and operation APIs |
| `src/diagnostics.ts` | Attribution of startup failures to non-core plugins |
| `src/client/index.tsx` | DSH plugin tree and current activity UI |
| `bin/diagnose.mjs` | Standalone diagnostics HTTP service |
| `bin/web-with-diagnostics.mjs` | `dsh web` wrapper and failure diagnostics entry point |
| `tests/*.test.mjs` | Report, Loader, activity, route, export, version, and diagnostics regression tests |

## Development and Verification

Node.js `^22.19.0` or `>=24.0.0` is required. On Windows, use Node 22/24 from PowerShell rather
than the Node 18 binary bundled with Git Bash.

```powershell
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm run build
npm test
node --check bin/diagnose.mjs
node --check bin/web-with-diagnostics.mjs
git diff --check
```

`npm test` builds first and then runs `tests/*.test.mjs`. The latest full verification passed all `61/61`
tests, along with typecheck, both diagnostics script checks, and `git diff --check`.

## Current Limitations

- Real Loader, Session Projection, and Session Query behavior depends on services exposed by the DSH host.
- Tool events without an explicit owner can only use stable mappings or remain marked as unconfirmed.
- Unit tests do not replace route, SSE replay, or visual checks against a real DSH Web host.
- Upstream directory, npm, and GitHub metadata require network access; offline mode uses cache when available.
