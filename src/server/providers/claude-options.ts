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

    // Read-only. `allowedTools` pre-approves so that no permission prompt can arise in a
    // headless session that has no terminal to show one on; `disallowedTools` is the fence.
    allowedTools: config.allowedTools,
    disallowedTools: config.disallowedTools,
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

    // A hard backstop with no typed SDK equivalent. `--restricted` removes the tools that run
    // commands or code, confines the file tools to the working directories, ignores user,
    // project and local settings files, and REFUSES bypassPermissions outright. That last
    // clause is the point: an app built on this scaffold cannot footgun itself into
    // bypassPermissions by changing one environment variable.
    //
    // NEVER add `--bare` here. Its own help says auth becomes "strictly ANTHROPIC_API_KEY or
    // apiKeyHelper … OAuth and keychain are never read" — the exact negation of running on
    // the user's subscription.
    extraArgs: { restricted: null },

    // Reached only when the permission flow falls through to a prompt, which the allow/deny
    // lists above are arranged to prevent. It is the backstop, and it is where an app that
    // wants inline approve/deny UI would post the request to the browser and await the
    // answer — the `signal` argument is there so that await can be cancelled.
    //
    // Fail closed: anything not explicitly ours is denied, so a tool added by a future CLI
    // release is refused rather than silently allowed.
    // `updatedInput` echoes the original input deliberately: the field REPLACES the tool's
    // arguments when present, so passing `{}` here would approve every call and then strip
    // everything the model asked for.
    canUseTool: async (toolName, input) =>
      toolName.startsWith('mcp__bunview__')
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `${toolName} is not enabled in BunView.` },
  }
}
