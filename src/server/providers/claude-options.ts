/**
 * Build the Agent SDK options for one turn. This file is the safety surface.
 *
 * Everything that decides what the agent may touch is here, in one function, so widening the
 * blast radius is a visible edit rather than an accumulation of defaults nobody reviewed.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { config } from '../config'
import { childEnv } from '../env'
import { appToolsServer } from '../mcp/app-tools'
import type { StreamOptions } from './types'

export function buildOptions(
  opts: StreamOptions,
  claudePath: string,
  abortController: AbortController,
  onStderr: (chunk: string) => void,
): Options {
  const model = opts.model === 'default' ? config.model : opts.model

  return {
    // Always explicit, in dev and in the compiled binary alike. The SDK's own resolution
    // walks node_modules, which does not exist inside a `bun build --compile` executable —
    // passing the discovered system path makes both environments behave identically.
    //
    // (The other supported option is bundling the platform binary and extracting it with
    // `extractFromBunfs`; see the README. Not used here because it would require all eight
    // per-platform packages to be installed in order to cross-compile five targets.)
    pathToClaudeCodeExecutable: claudePath,

    // Token-level deltas. Without this the UI gets whole messages and the answer appears in
    // one paste after a long silence.
    includePartialMessages: true,

    abortController,
    env: childEnv(),
    cwd: config.cwd,
    stderr: onStderr,

    ...(model ? { model } : {}),
    // Session-scoped: this overrides the user's configured effort for this request only and
    // never writes to their config. Defaults to 'low' upstream in the request parser.
    effort: opts.effort,

    // THE FENCE. `tools` is the base set of built-in tools that exist at all for this
    // session; anything not named here cannot be called, cannot be prompted for, and cannot
    // be added by a future CLI release. It replaced a `disallowedTools` denylist, which had
    // the inverse and much worse property — a new built-in tool was permitted until someone
    // noticed and added it to the list. The SDK's own docs point here: "To restrict which
    // tools are available, use the `tools` option instead."
    //
    // This governs BUILT-IN tools only; `mcpServers` below is a separate surface, so the
    // app's own tools survive even at `tools: []`.
    tools: config.tools,

    // Pre-approval, NOT restriction. Everything in `tools` is named here too, so a headless
    // session with no terminal to show a prompt on never has to show one.
    allowedTools: config.allowedTools,

    // `dontAsk`: deny anything not pre-approved rather than prompting into the void.
    permissionMode: config.permissionMode as Options['permissionMode'],

    // The app's own tools, running in this process. See ../mcp/app-tools.ts.
    mcpServers: { bunview: appToolsServer },
    // Do not inherit the user's configured MCP servers.
    strictMcpConfig: true,
    // Do not inherit their CLAUDE.md, skills or hooks. See config.ts for why this is empty.
    settingSources: config.settingSources,

    ...(config.appendSystemPrompt
      ? {
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: config.appendSystemPrompt,
          },
        }
      : {}),

    ...(opts.sessionId ? { resume: opts.sessionId } : {}),

    // NO `extraArgs` HERE, deliberately. This used to pass `--restricted`, which is not a flag
    // the CLI has: 2.1.236 exits 1 with "unknown option '--restricted'", and an unrecognised
    // flag is fatal rather than ignored, so every single turn failed with `cli_failed`.
    //
    // Each guarantee it was carrying is covered by the typed options above, which the SDK
    // translates into whatever the installed CLI actually accepts:
    //
    //   * no tools that run commands or code → `tools`, which is an allowlist: Bash, Write
    //     and Edit are not denied, they are absent. Plus `canUseTool` below for anything that
    //     reaches the permission flow anyway
    //   * file tools confined to the workspace → the CLI already confines them to `cwd`;
    //     widening it requires an explicit `--add-dir`, which nothing here passes
    //   * user, project and local settings ignored → `settingSources: []`
    //   * bypassPermissions refused → config.ts exits at startup unless BUNVIEW_ALLOW_BYPASS=1
    //     is set alongside it
    //
    // Think hard before adding a raw flag back. `extraArgs` is unchecked passthrough to a
    // binary this app does not version-pin, so a flag that is merely renamed upstream takes
    // the whole app down rather than degrading.
    //
    // NEVER add `--bare`. Its own help says auth becomes "strictly ANTHROPIC_API_KEY or
    // apiKeyHelper … OAuth and keychain are never read" — the exact negation of running on
    // the user's subscription.

    // Reached only when the permission flow falls through to a prompt, which `tools` and
    // `allowedTools` above are arranged to prevent. It is the backstop, and it is where an app
    // that wants inline approve/deny UI would post the request to the browser and await the
    // answer — the `signal` argument is there so that await can be cancelled.
    //
    // NOT consulted for anything named in `allowedTools`. A bare entry there auto-approves
    // the whole tool before this runs, which the SDK warns about at startup
    // (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED). So for Read, Grep, Glob and mcp__bunview__* the
    // list below is what decides, and this callback's `deny` for the first three never fires
    // — read the two together or you will conclude Read is blocked when it is allowed.
    // Gating every call instead would mean a PreToolUse hook, or dropping the bare names and
    // accepting that a prompt can arise in a session with no terminal to show it on.
    //
    // Fail closed for everything else. Note this is now the SECOND line of defence rather than
    // the only one: a tool added by a future CLI release is no longer merely refused here, it
    // is absent from the session because `tools` above never named it.
    // `updatedInput` echoes the original input deliberately: the field REPLACES the tool's
    // arguments when present, so passing `{}` here would approve every call and then strip
    // everything the model asked for.
    canUseTool: async (toolName, input) =>
      toolName.startsWith('mcp__bunview__')
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `${toolName} is not enabled in BunView.` },
  }
}
