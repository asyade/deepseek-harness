# Agent Note: MCP resources as model-pulled helper tools

Status: implemented

English | [中文](2026-09-02-mcp-client-resources-bridge.zh.md)

## Problem

The [MCP client](2026-07-07-mcp-client-plugin.md) bridged tools only. Servers that publish resources — files, database schemas, logs, application state — exposed them to no one: `resources/list` and `resources/read` were never called, and the package README recorded Resources as deferred because "bridging needs a harness-side injection decision". The decision was the blocker, not the protocol work.

## Decision

MCP calls resources application-controlled: the spec defines the wire methods and leaves the host to decide how contents reach the model. Two host patterns exist — user-attached, where a picker UI resolves a `@`-mention into injected context (Cursor), and model-pulled, where the host publishes reading tools and the model decides (Claude Code's `ListMcpResources`/`ReadMcpResource`). The harness has no attachment picker, so model-pulled is the only pattern it can express, and the injection decision becomes a bounded tool pair rather than a prompt-assembly policy.

`packages/mcp/mcp-client/src/resources.ts` owns the helpers; `syncTools` appends them to the generation it is already building.

**Same generation, not a second one.** The helpers register through the same atomic dispose-previous/register-next swap as the server's own tools, so they appear, re-sync, and disappear with it. A separate registration path would need its own rollback and disposal rules for no gain.

**Capability-gated, then config-gated.** A server that does not advertise `resources` in `initialize` contributes nothing, and no `resources/*` request is ever sent to it. `resources.enabled: false` skips the capability check too.

**The server's own tool wins a collision.** A server publishing a tool named `list_resources` keeps that name; the helper is skipped with a warning. The reverse — a helper shadowing a real tool the model can call — would silently remove server functionality.

**No cache, no subscription.** Every call reads live state, so `resources/subscribe`, `notifications/resources/updated`, and `listChanged` are irrelevant to correctness and unimplemented: there is no cached copy that could go stale. Re-sync, reconnect, and disposal therefore need no resource-specific handling.

**Bounds belong to the emitted text.** `list_resources` drains pagination up to `maxListEntries` and hands back the page cursor that resumes the listing; `read_resource` truncates at `maxContentChars` across the whole joined result, not per entry. Untrusted server data is rendered defensively — a descriptor missing its `uri`, a content entry that is not an object, and a binary `blob` each become a bracketed diagnostic line rather than missing data or base64 in context. `resolveResourceBounds` is the explicit resolve step, matching `resolveReconnectPolicy`.

## Alternatives considered

**A sibling `mcp-resources` plugin, leaving `mcp-client` untouched for easier upstreaming.** Rejected after costing it: the plugin would open its own connection to the same server, which for stdio means a second child process, and the server's `command`/`args`/`url` would be duplicated across two `cordis.yml` rows that can drift. The alternative — `mcp-client` publishing its live connections as a service — is a larger change to the same package than adding the bridge to it.

**Auto-injecting resource contents into the system prompt.** Rejected: contents are unbounded and mostly irrelevant to a given turn, the token cost lands on every request, and a changed resource would invalidate the prompt prefix. Listing metadata is cheap; reading is the expensive call, and the model is the only party that knows which resource matters.

**Routing binary contents into the attachment store, as image tool results already are.** Deferred, not rejected: resources carry no capability proof comparable to the image route's, and a size-and-type diagnostic is honest about what the model can act on. The README records it as an open direction.

**Completing URI templates through the MCP completion API.** Deferred: templates are listed for the model to expand. Completion is a separate protocol surface whose value depends on a picker the harness does not have.

## Testing

Unit (`tests/resources.spec.ts`, mocked client): registration under the capability gate and its absence, the disabled path proving no capability call is made, collision precedence with its warning, disposal removing both helpers, pagination drain, the cap with its resume cursor, caller-cursor pass-through, template rendering, annotation rendering, the `title`-over-`name` label preference, invalid descriptors, read joining and truncation, the binary diagnostic proving base64 stays out, empty results, server-error propagation, a missing `uri`, and every `resolveResourceBounds` branch. E2E (`tests/mcp-client.e2e.ts`, keyless): the stdio fixture server gained a text resource and a binary one; a real-process test lists both and reads each over the real protocol. Snapshot: none — the helpers produce ordinary text tool results with no new presentation shape.

## Consequences

- Two tool definitions enter every request for a resources-capable server. That is the standing cost of discoverability; `resources.enabled: false` removes it.
- The model sees a resource only when it asks. A resource that changes mid-turn is observed on the next call, never pushed.
- `resources` is new config surface on both transports.
- Prompts remain unbridged: they need a prompt-template concept the harness lacks, which resources did not require.
