# PulseCortex

PulseCortex is a local daemon that lets one paired Feishu owner control
allowlisted Codex sessions. Feishu uses outbound WebSocket connections, and
Codex uses a loopback-only app-server shared by Feishu and local terminals.

## Before You Start

- Node.js 25.9.0 or newer
- Codex CLI `0.147.x` or newer, installed and authenticated
- A Feishu enterprise self-built app with a bot
- Outbound access to Feishu and your model provider

Prompts, agent output, source excerpts, diffs, logs, and requested results are
sent to Feishu. Use PulseCortex only with repositories and credentials that
your Feishu tenant is authorized to receive. See the [security model](docs/security.md)
for the complete boundary and residual risks.

## Quick Start From npm

Install the CLI and daemon at the same version:

```bash
npm install --global @pulsecortex/cli@latest @pulsecortex/daemon@latest
pulsectl init
```

After `pulsectl init`, follow [Configure Feishu](#configure-feishu) below and
put the App ID, App Secret, and a random signing key in the environment file it
prints:

```dotenv
FEISHU_APP_ID=cli_your_app_id
FEISHU_APP_SECRET=your_app_secret
PULSECORTEX_ACTION_SIGNING_KEY=your_random_signing_key
```

Then register a project, check the installation, pair the owner, and start the
daemon in the foreground:

```bash
pulsectl project add my-project /absolute/path/to/project
pulsectl diagnose
pulsectl pair
pulsecortex
```

Send `/pair <code>` to the bot. After pairing, use `/projects` or
`/new my-project` in the direct chat. Keep the daemon terminal open. To start it at
user login instead, run `pulsectl service install` and check it with
`pulsectl service status`.

For a one-off run without a global daemon command:

```bash
npx --yes @pulsecortex/daemon@latest
```

The package still requires the initialized configuration and environment file.
For the release and package workflow, see [publishing](docs/publishing.md).

## Configure Feishu

Follow [Feishu setup](docs/feishu-setup.md) to create the bot, grant the two
required direct-message scopes, enable long-connection events and callbacks,
and publish the application version. No public URL, webhook endpoint, or
inbound firewall rule is required.

## Build From Source

Use this workflow when developing PulseCortex rather than installing published
packages:

```bash
pnpm install
pnpm build
pnpm pulsectl init
pnpm pulsectl project add my-project /absolute/path/to/project
pnpm pulsectl diagnose
pnpm pulsectl pair
pnpm start
```

During development, `pnpm dev` runs the daemon directly from TypeScript.
Replace `pnpm pulsectl` with `pulsectl` when using the npm installation.

## Local Codex Integration

After building, install the optional shell integration:

```bash
pnpm pulsectl shell install
```

Open a new terminal and run `codex` from a registered project. Interactive
commands use the shared PulseCortex app-server; maintenance commands continue
to use Codex directly. If the daemon is unavailable, the shim warns and falls
back to standalone Codex. Remove the integration with
`pnpm pulsectl shell uninstall`.

The explicit launcher is also available:

```bash
pnpm pulsectl codex my-project
```

## Feishu Commands

| Command | Purpose |
| --- | --- |
| `/projects` | Choose a registered project |
| `/new [project] [task]` | Create a session and optionally start work |
| `/sessions` | Browse discoverable sessions |
| `/resume <session-id>` | Select or resume a session |
| `/send <message>` | Start or steer the selected session |
| `/status` | Show the selected session's status |
| `/stop` | Interrupt the selected session |
| `/logs` | Browse bounded command logs |
| `/diff` | Show the bounded unified diff |
| `/instructions` | Run supported Codex built-ins or choose a preset |
| `/help` | Show command help |

Selecting a session makes it the target for ordinary text and `/send`. Without
a selected session, `/send` creates one in the selected or default project.
Sessions remain limited to registered project paths; see [operations](docs/operations.md)
for discovery, recovery, logging, and service behavior.

## Development Checks

```bash
pnpm typecheck
pnpm test
pnpm build
```

Regenerate the app-server protocol only with the supported Codex CLI:

```bash
pnpm protocol:generate
```

Runtime accepts newer Codex releases after read-only app-server compatibility
checks. Protocol generation remains pinned to the snapshot series in
`packages/codex-driver/src/protocol.ts`.

See the [architecture](docs/architecture.md), [operations](docs/operations.md),
[security](docs/security.md), and [publishing](docs/publishing.md) guides for
design details, administration, security controls, and releases.
