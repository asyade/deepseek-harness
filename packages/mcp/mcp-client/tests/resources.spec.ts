import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { syncTools, type ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import { RESOURCE_DEFAULTS, resolveResourceBounds } from '@deepseek-ai/dsh-mcp-client/src/resources.ts'

const testToolSignal = new AbortController().signal

interface MockResponses {
  capabilities?: Record<string, unknown>
  tools?: { name: string; description?: string; inputSchema: Record<string, unknown> }[]
  list?: (cursor: string | undefined) => Record<string, unknown>
  templates?: Record<string, unknown>
  read?: (uri: string) => Record<string, unknown>
}

/**
 * MCP client fake routing the four methods the resources bridge speaks. Each
 * responder receives the raw params so tests can assert cursor propagation.
 */
function createMockClient(responses: MockResponses) {
  return {
    getServerCapabilities: vi.fn(() => responses.capabilities ?? { tools: {}, resources: {} }),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(async (request: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
      if (request.method === 'tools/list') return { tools: responses.tools ?? [], nextCursor: undefined }
      if (request.method === 'resources/list') {
        return responses.list?.(request.params?.cursor as string | undefined) ?? { resources: [] }
      }
      if (request.method === 'resources/templates/list') return responses.templates ?? { resourceTemplates: [] }
      if (request.method === 'resources/read') return responses.read?.(request.params?.uri as string) ?? { contents: [] }
      throw new Error(`unexpected MCP request: ${request.method}`)
    }),
  }
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

const opts: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
  resources: { maxListEntries: 500, maxContentChars: 32_000 },
}

/** Run one registered helper and return its joined text output. */
async function runTool(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name, arguments: args })
  if (result.error !== undefined) throw new Error(result.error.message)
  return result.content.map(block => (block as { text?: string }).text ?? '').join('\n')
}

describe('resources bridge registration', () => {
  it('registers both helpers when the server advertises the resources capability', async () => {
    const ctx = await mountRegistry()
    await syncTools(createMockClient({}) as never, ctx, opts, new Map())

    expect(ctx.tools.get('mcp__srv__list_resources')).toBeDefined()
    expect(ctx.tools.get('mcp__srv__read_resource')).toBeDefined()
  })

  it('registers nothing extra when the server omits the resources capability', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({ capabilities: { tools: {} } })
    await syncTools(client as never, ctx, opts, new Map())

    expect(ctx.tools.get('mcp__srv__list_resources')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__read_resource')).toBeUndefined()
    expect(client.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'resources/list' }), expect.anything(), expect.anything(),
    )
  })

  it('registers nothing extra when the bridge is disabled for this server', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({})
    await syncTools(client as never, ctx, { ...opts, resources: undefined }, new Map())

    expect(ctx.tools.get('mcp__srv__list_resources')).toBeUndefined()
    expect(client.getServerCapabilities).not.toHaveBeenCalled()
  })

  it("lets the server's own tool win a name collision and skips the helper", async () => {
    const ctx = await mountRegistry()
    const warn = vi.spyOn(ctx.logger, 'warn')
    const client = createMockClient({
      tools: [{ name: 'list_resources', description: 'the server owns this name', inputSchema: { type: 'object', properties: {} } }],
    })
    await syncTools(client as never, ctx, opts, new Map())

    expect(ctx.tools.get('mcp__srv__list_resources')?.description).toBe('the server owns this name')
    expect(ctx.tools.get('mcp__srv__read_resource')).toBeDefined()
    expect(warn.mock.calls[0]?.[0]).toContain('collides with the resources bridge helper')
  })

  it('disposes the helpers with the generation they belong to', async () => {
    const ctx = await mountRegistry()
    const disposers = await syncTools(createMockClient({}) as never, ctx, opts, new Map())
    for (const dispose of disposers.values()) dispose()

    expect(ctx.tools.get('mcp__srv__list_resources')).toBeUndefined()
    expect(ctx.tools.get('mcp__srv__read_resource')).toBeUndefined()
  })
})

describe('list_resources', () => {
  it('drains pagination and renders metadata with annotations and templates', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      list: cursor => cursor === undefined
        ? {
          resources: [{ uri: 'file:///a.txt', name: 'a', description: 'first', mimeType: 'text/plain' }],
          nextCursor: 'page2',
        }
        : {
          resources: [{
            uri: 'file:///b.txt',
            name: 'b',
            annotations: { audience: ['assistant'], priority: 0.8, lastModified: '2026-01-01T00:00:00Z' },
          }],
        },
      templates: { resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'any file' }] },
    })
    await syncTools(client as never, ctx, opts, new Map())

    const text = await runTool(ctx, 'mcp__srv__list_resources', {})
    expect(text).toContain('- file:///a.txt — a — first (text/plain)')
    expect(text).toContain('- file:///b.txt — b [audience: assistant; priority: 0.8; modified: 2026-01-01T00:00:00Z]')
    expect(text).toContain('- template: file:///{path} — any file')
  })

  it('caps the list and offers the page cursor that resumes it', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      list: cursor => ({
        resources: [{ uri: `file:///${cursor ?? 'first'}-1` }, { uri: `file:///${cursor ?? 'first'}-2` }],
        nextCursor: cursor === undefined ? 'page2' : undefined,
      }),
    })
    await syncTools(client as never, ctx, { ...opts, resources: { maxListEntries: 3, maxContentChars: 100 } }, new Map())

    const text = await runTool(ctx, 'mcp__srv__list_resources', {})
    expect(text).toContain('[list truncated at 3 entries — pass cursor "page2" to continue]')
    expect(text).not.toContain('page2-2')
  })

  it('passes the caller cursor through to the server', async () => {
    const ctx = await mountRegistry()
    const seen: (string | undefined)[] = []
    const client = createMockClient({
      list: (cursor) => {
        seen.push(cursor)
        return { resources: [] }
      },
    })
    await syncTools(client as never, ctx, opts, new Map())
    await runTool(ctx, 'mcp__srv__list_resources', { cursor: 'resume-here' })

    expect(seen).toEqual(['resume-here'])
  })

  it('says so plainly when the server has no resources', async () => {
    const ctx = await mountRegistry()
    await syncTools(createMockClient({}) as never, ctx, opts, new Map())

    expect(await runTool(ctx, 'mcp__srv__list_resources', {})).toContain('"srv" exposes no resources')
  })

  it("prefers the spec's display title over the programmatic name", async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      list: () => ({ resources: [{ uri: 'file:///a.txt', name: 'a', title: 'Notes' }] }),
    })
    await syncTools(client as never, ctx, opts, new Map())

    expect(await runTool(ctx, 'mcp__srv__list_resources', {})).toContain('- file:///a.txt — Notes')
  })

  it('reports an unusable descriptor instead of dropping it', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      list: () => ({ resources: [{ name: 'no uri here' }] }),
      templates: { resourceTemplates: [{ name: 'no template here' }] },
    })
    await syncTools(client as never, ctx, opts, new Map())

    const text = await runTool(ctx, 'mcp__srv__list_resources', {})
    expect(text).toContain('[invalid resource entry: missing uri]')
    expect(text).toContain('[invalid resource template: missing uriTemplate]')
  })
})

describe('read_resource', () => {
  it('joins text contents under per-entry headers', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      read: uri => ({ contents: [{ uri, mimeType: 'text/plain', text: 'hello' }] }),
    })
    await syncTools(client as never, ctx, opts, new Map())

    expect(await runTool(ctx, 'mcp__srv__read_resource', { uri: 'file:///a.txt' }))
      .toBe('[file:///a.txt (text/plain)]\nhello')
  })

  it('truncates at the character budget and says the content continues', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      read: uri => ({ contents: [{ uri, text: 'abcdefghij' }] }),
    })
    await syncTools(client as never, ctx, { ...opts, resources: { maxListEntries: 10, maxContentChars: 4 } }, new Map())

    const text = await runTool(ctx, 'mcp__srv__read_resource', { uri: 'file:///a.txt' })
    expect(text).toContain('[file:///a.txt]\nabcd')
    expect(text).not.toContain('efgh')
    expect(text).toContain('[read truncated at 4 characters — the resource content continues]')
  })

  it('describes a binary resource instead of dumping its base64', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      read: uri => ({ contents: [{ uri, mimeType: 'image/png', blob: 'AAAAAAAA' }] }),
    })
    await syncTools(client as never, ctx, opts, new Map())

    const text = await runTool(ctx, 'mcp__srv__read_resource', { uri: 'file:///a.png' })
    expect(text).toBe('[binary resource omitted: file:///a.png (image/png), ~6 bytes]')
    expect(text).not.toContain('AAAAAAAA')
  })

  it('reports an empty result rather than returning nothing', async () => {
    const ctx = await mountRegistry()
    await syncTools(createMockClient({}) as never, ctx, opts, new Map())

    expect(await runTool(ctx, 'mcp__srv__read_resource', { uri: 'file:///gone.txt' }))
      .toBe('(the server returned no contents for file:///gone.txt)')
  })

  it('propagates a server error such as -32002 resource not found', async () => {
    const ctx = await mountRegistry()
    const client = createMockClient({
      read: () => { throw new Error('MCP error -32002: Resource not found') },
    })
    await syncTools(client as never, ctx, opts, new Map())

    await expect(runTool(ctx, 'mcp__srv__read_resource', { uri: 'file:///gone.txt' }))
      .rejects.toThrow('-32002')
  })

  it('rejects a missing uri with a message pointing at the list helper', async () => {
    const ctx = await mountRegistry()
    await syncTools(createMockClient({}) as never, ctx, opts, new Map())

    await expect(runTool(ctx, 'mcp__srv__read_resource', { uri: '' }))
      .rejects.toThrow('mcp__srv__list_resources')
  })
})

describe('resolveResourceBounds', () => {
  it('takes every default when the config is absent', () => {
    expect(resolveResourceBounds(undefined, 'p')).toEqual({
      maxListEntries: RESOURCE_DEFAULTS.maxListEntries,
      maxContentChars: RESOURCE_DEFAULTS.maxContentChars,
    })
  })

  it('disables the bridge when enabled is false', () => {
    expect(resolveResourceBounds({ ...RESOURCE_DEFAULTS, enabled: false }, 'p')).toBeUndefined()
  })

  it('rejects an unknown option and a non-positive bound', () => {
    expect(() => resolveResourceBounds({ maxListEntreis: 1 } as never, 'p')).toThrow('p.maxListEntreis is not a resources option')
    expect(() => resolveResourceBounds({ ...RESOURCE_DEFAULTS, maxContentChars: 0 }, 'p')).toThrow('p.maxContentChars must be a positive integer')
  })
})
