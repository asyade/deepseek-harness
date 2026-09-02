/**
 * Resources bridge: exposes an MCP server's resources to the model as native
 * harness tools following the model-pulled pattern — the model discovers
 * resources with `list_resources` (bounded metadata) and reads contents with
 * `read_resource` (bounded text). Registration is capability-gated: servers
 * that do not advertise `capabilities.resources` register nothing extra.
 *
 * There is no cache and no subscription: every tool call hits the live
 * generation, so re-sync, reconnect, and disposal semantics stay identical to
 * the tool bridge. `listChanged` and per-resource `updated` notifications are
 * therefore irrelevant to correctness — a fresh call always sees fresh state.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { publicToolName, type ResourceBounds, type ToolBridgeOptions } from './tools.ts'

/**
 * Resources bridge settings for one server. The helpers are also
 * capability-gated: a server that does not advertise `resources` gets none
 * regardless of `enabled`.
 */
export interface ResourcesConfig {
  /** Register the `list_resources` and `read_resource` helpers for this server. */
  enabled: boolean
  /** Maximum resource and template entries rendered by one `list_resources` call. */
  maxListEntries: number
  /** Maximum characters of resource text rendered by one `read_resource` call. */
  maxContentChars: number
}

/** Defaults shared by the Config schema and {@link resolveResourceBounds}. */
export const RESOURCE_DEFAULTS: Readonly<ResourcesConfig> = Object.freeze({
  enabled: true,
  maxListEntries: 500,
  maxContentChars: 32_000,
})

/**
 * The one explicit resolve step from raw resources config to the bounds the
 * bridge enforces. Programmatic construction may bypass Schemastery
 * normalization, so every default and bound is re-judged here —
 * misconfiguration fails the plugin instance at load.
 *
 * @param config - Raw resources config, or undefined to take every default.
 * @param path - Config path used in error messages (`<plugin>.resources`).
 * @returns The bounds to enforce, or undefined when the bridge is disabled.
 */
export function resolveResourceBounds(
  config: ResourcesConfig | undefined,
  path: string,
): ResourceBounds | undefined {
  if (config !== undefined) {
    for (const key of Object.keys(config)) {
      if (!Object.hasOwn(RESOURCE_DEFAULTS, key)) throw new Error(`${path}.${key} is not a resources option`)
    }
  }
  if (!(config?.enabled ?? RESOURCE_DEFAULTS.enabled)) return undefined
  const maxListEntries = config?.maxListEntries ?? RESOURCE_DEFAULTS.maxListEntries
  const maxContentChars = config?.maxContentChars ?? RESOURCE_DEFAULTS.maxContentChars
  if (!Number.isInteger(maxListEntries) || maxListEntries < 1) {
    throw new Error(`${path}.maxListEntries must be a positive integer`)
  }
  if (!Number.isInteger(maxContentChars) || maxContentChars < 1) {
    throw new Error(`${path}.maxContentChars must be a positive integer`)
  }
  return { maxListEntries, maxContentChars }
}

/** Raw name of the resources-listing helper tool. */
const LIST_RESOURCES_NAME = 'list_resources'

/** Raw name of the resource-reading helper tool. */
const READ_RESOURCE_NAME = 'read_resource'

/** Raw result record: the bridge owns field validation after transport. */
const RawResourcesResultSchema = z.record(z.string(), z.unknown())

/** Canonical output contract shared by both helper tools: text-only content. */
const TEXT_OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    content: { type: 'array', items: {} },
  },
  required: ['content'],
  additionalProperties: false,
}

/** Project the executor's own `{ content }` result back out for rendering. */
function renderTextContent(_args: unknown, value: JsonValue): ContentBlock[] {
  return (value as unknown as { content: ContentBlock[] }).content
}

/** One resources-bridge tool contribution for a sync generation. */
export interface ResourceToolEntry {
  /** The MCP server's own raw name (`list_resources` or `read_resource`). */
  rawName: string
  /** Registry-qualified public name derived from `(serverName, rawName)`. */
  publicName: string
  /** Complete ToolRuntime definition for the helper. */
  definition: ToolDefinition
}

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one optional string field from an untrusted record. */
function readString(record: { [key: string]: JsonValue }, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Build the capability-gated resources helper tools for one live generation.
 *
 * @param client - Connected MCP Client whose advertised capabilities gate the helpers.
 * @param opts - Bridge options; `resources` absent disables the bridge entirely.
 * @returns The helper contributions, or an empty array when the bridge is
 *   disabled for this server or the server did not advertise `resources`.
 */
export function buildResourceDefinitions(
  client: Client,
  opts: ToolBridgeOptions,
): ResourceToolEntry[] {
  const bounds = opts.resources
  if (bounds === undefined) return []
  const capabilities = client.getServerCapabilities()
  if (capabilities?.resources === undefined) return []
  return [
    buildListResourcesEntry(client, opts, bounds),
    buildReadResourceEntry(client, opts, bounds),
  ]
}

/** Build `list_resources`: bounded metadata for resources and URI templates. */
function buildListResourcesEntry(
  client: Client,
  opts: ToolBridgeOptions,
  bounds: ResourceBounds,
): ResourceToolEntry {
  const publicName = publicToolName(opts.serverName, LIST_RESOURCES_NAME)
  return {
    rawName: LIST_RESOURCES_NAME,
    publicName,
    definition: {
      name: publicName,
      description: `List the resources exposed by the MCP server "${opts.serverName}" — metadata only (URI, name, description, MIME type), never contents. Also lists URI templates for parameterized resources. Pass the returned nextCursor to page further. Use ${publicToolName(opts.serverName, READ_RESOURCE_NAME)} with a URI to fetch contents.`,
      parameters: {
        type: 'object',
        properties: {
          cursor: {
            type: 'string',
            description: 'Opaque pagination cursor from a previous call\'s nextCursor; omit for the first page',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: TEXT_OUTPUT_SCHEMA,
        render: renderTextContent,
      },
      isConcurrencySafe: () => true,
      execute: async (args: unknown, exec: ToolExecution) => {
        const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        let pageCursor = typeof argsObj.cursor === 'string' && argsObj.cursor.length > 0 ? argsObj.cursor : undefined
        const resourceLines: string[] = []
        const templateLines: string[] = []
        let resumeCursor: string | undefined
        let moreTemplates = false

        // Drain resource pages until the entry cap; on cap, remember the page
        // cursor so the model can resume with a follow-up call. Pagination
        // cursors are opaque, so a resumed call re-lists that page from its
        // start and may repeat a few entries around the page boundary.
        let capped = false
        do {
          const page = await requestPage(client, 'resources/list', pageCursor, exec, opts)
          const batch = Array.isArray(page.resources) ? page.resources : []
          for (const entry of batch) {
            if (resourceLines.length >= bounds.maxListEntries) {
              capped = true
              resumeCursor = pageCursor
              break
            }
            resourceLines.push(renderResourceEntry(entry))
          }
          if (capped) break
          pageCursor = readString(page, 'nextCursor')
        } while (pageCursor !== undefined)

        // Templates are one page in practice; cap them identically but do not
        // offer a resume cursor — a follow-up list call re-derives them.
        const templatePage = await requestPage(client, 'resources/templates/list', undefined, exec, opts)
        const templates = Array.isArray(templatePage.resourceTemplates) ? templatePage.resourceTemplates : []
        for (const entry of templates) {
          if (templateLines.length >= bounds.maxListEntries) {
            moreTemplates = true
            break
          }
          templateLines.push(renderTemplateEntry(entry))
        }

        const sections: string[] = []
        if (resourceLines.length === 0 && templateLines.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `"${opts.serverName}" exposes no resources (and the server did not fail the request — it has none to list).`,
            }],
          }
        }
        if (resourceLines.length > 0) {
          sections.push(`Resources on MCP server "${opts.serverName}":\n${resourceLines.join('\n')}`)
        }
        if (templateLines.length > 0) {
          sections.push(`Resource templates on "${opts.serverName}" (expand the template, then read the resulting URI):\n${templateLines.join('\n')}`)
        }
        if (capped) {
          sections.push(`[list truncated at ${bounds.maxListEntries} entries — pass cursor "${resumeCursor}" to continue]`)
        }
        if (moreTemplates) {
          sections.push(`[template list truncated at ${bounds.maxListEntries} entries]`)
        }
        return { content: [{ type: 'text', text: sections.join('\n\n') }] }
      },
    },
  }
}

/** Build `read_resource`: bounded text contents for one resource URI. */
function buildReadResourceEntry(
  client: Client,
  opts: ToolBridgeOptions,
  bounds: ResourceBounds,
): ResourceToolEntry {
  const publicName = publicToolName(opts.serverName, READ_RESOURCE_NAME)
  return {
    rawName: READ_RESOURCE_NAME,
    publicName,
    definition: {
      name: publicName,
      description: `Read the current text contents of one resource from the MCP server "${opts.serverName}" by URI. URIs come from ${publicToolName(opts.serverName, LIST_RESOURCES_NAME)} or from resource links in tool results. Binary resources are reported as diagnostics instead of raw data. Output is capped at ${bounds.maxContentChars} characters.`,
      parameters: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            description: 'Resource URI to read, exactly as listed (e.g. "file:///project/src/main.rs")',
          },
        },
        required: ['uri'],
        additionalProperties: false,
      },
      output: {
        schema: TEXT_OUTPUT_SCHEMA,
        render: renderTextContent,
      },
      isConcurrencySafe: () => true,
      execute: async (args: unknown, exec: ToolExecution) => {
        const argsObj = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
        const uri = typeof argsObj.uri === 'string' ? argsObj.uri : undefined
        if (uri === undefined || uri.length === 0) {
          throw new Error(`read_resource requires a non-empty "uri" argument — call ${publicToolName(opts.serverName, LIST_RESOURCES_NAME)} first to discover resource URIs`)
        }
        const result = await client.request(
          { method: 'resources/read', params: { uri } },
          RawResourcesResultSchema,
          { signal: exec.signal, timeout: opts.toolCallTimeoutMs },
        )
        const contents: JsonValue[] = Array.isArray(result.contents) ? result.contents as JsonValue[] : []
        const parts: string[] = []
        let used = 0
        let truncated = false
        for (const raw of contents) {
          if (!isRecord(raw)) {
            parts.push('[invalid resource content: expected an object]')
            continue
          }
          const entryUri = readString(raw, 'uri') ?? '(unknown uri)'
          const mimeType = readString(raw, 'mimeType')
          const header = mimeType === undefined ? `[${entryUri}]` : `[${entryUri} (${mimeType})]`
          const text = raw.text
          if (typeof text === 'string') {
            const remaining = bounds.maxContentChars - used
            if (remaining <= 0) {
              truncated = true
              break
            }
            const shown = remaining < text.length ? text.slice(0, remaining) : text
            used += shown.length
            truncated = truncated || shown.length < text.length
            parts.push(`${header}\n${shown}`)
            if (shown.length < text.length) break
          } else if (typeof raw.blob === 'string') {
            // Binary resources stay out of model context; the raw blob remains
            // in the canonical protocol error path only as this diagnostic.
            const approxBytes = Math.floor(raw.blob.length * 3 / 4)
            parts.push(`[binary resource omitted: ${entryUri}${mimeType === undefined ? '' : ` (${mimeType})`}, ~${approxBytes} bytes]`)
          } else {
            parts.push(`[empty resource: ${entryUri}]`)
          }
        }
        if (truncated) {
          parts.push(`[read truncated at ${bounds.maxContentChars} characters — the resource content continues]`)
        }
        if (parts.length === 0) {
          parts.push(`(the server returned no contents for ${uri})`)
        }
        return { content: [{ type: 'text', text: parts.join('\n') }] }
      },
    },
  }
}

/** One raw `resources/list`-style request without SDK output pre-validation. */
async function requestPage(
  client: Client,
  method: 'resources/list' | 'resources/templates/list',
  cursor: string | undefined,
  exec: ToolExecution,
  opts: ToolBridgeOptions,
): Promise<{ [key: string]: JsonValue }> {
  const result = await client.request(
    { method, ...cursor === undefined ? {} : { params: { cursor } } },
    RawResourcesResultSchema,
    { signal: exec.signal, timeout: opts.toolCallTimeoutMs },
  )
  return isRecord(result as JsonValue) ? result as { [key: string]: JsonValue } : {}
}

/** Render one untrusted resource descriptor as one bounded text line. */
function renderResourceEntry(entry: JsonValue): string {
  if (!isRecord(entry)) return '[invalid resource entry: expected an object]'
  const uri = readString(entry, 'uri')
  if (uri === undefined) return '[invalid resource entry: missing uri]'
  return `- ${renderDescriptor(uri, entry)}${renderAnnotations(entry)}`
}

/** Render one untrusted resource-template descriptor as one bounded text line. */
function renderTemplateEntry(entry: JsonValue): string {
  if (!isRecord(entry)) return '[invalid resource template: expected an object]'
  const uriTemplate = readString(entry, 'uriTemplate')
  if (uriTemplate === undefined) return '[invalid resource template: missing uriTemplate]'
  return `- template: ${renderDescriptor(uriTemplate, entry)}${renderAnnotations(entry)}`
}

/**
 * Shared `uri — label — description (mime)` line shape. The label prefers the
 * spec's display `title` and falls back to the programmatic `name`.
 */
function renderDescriptor(uri: string, entry: { [key: string]: JsonValue }): string {
  const bits = [uri]
  const label = readString(entry, 'title') ?? readString(entry, 'name')
  if (label !== undefined) bits.push(label)
  const description = readString(entry, 'description')
  if (description !== undefined) bits.push(description)
  const mimeType = readString(entry, 'mimeType')
  return `${bits.join(' — ')}${mimeType === undefined ? '' : ` (${mimeType})`}`
}

/** Append the spec's optional annotations (`audience`, `priority`, `lastModified`). */
function renderAnnotations(entry: { [key: string]: JsonValue }): string {
  const annotations = entry.annotations
  if (!isRecord(annotations)) return ''
  const bits: string[] = []
  const audience = annotations.audience
  const named = Array.isArray(audience) ? audience.filter(one => typeof one === 'string') : []
  if (named.length > 0) bits.push(`audience: ${named.join(', ')}`)
  const priority = annotations.priority
  if (typeof priority === 'number') bits.push(`priority: ${priority}`)
  const lastModified = readString(annotations, 'lastModified')
  if (lastModified !== undefined) bits.push(`modified: ${lastModified}`)
  return bits.length === 0 ? '' : ` [${bits.join('; ')}]`
}
