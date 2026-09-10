import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LspDiagnostics, { LspDiagnosticsProviderId } from '../src/index.ts'

describe('diagnostics migration contract', () => {
  it('normalizes workspace requests and releases the provider on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(LspDiagnostics)
    await expect(ctx.lspDiagnostics.diagnostics({ workspaceRoot: '/workspace' }))
      .rejects.toMatchObject({ code: 'LSP_UNAVAILABLE' })
    const diagnostics = vi.fn(async ({ workspaceRoot }: { workspaceRoot: string }) => ({ workspaceRoot, diagnostics: [], timestamp: Date.now() }))
    const unsubscribe = vi.fn()
    const provider = { id: LspDiagnosticsProviderId('migration'), diagnostics,
      onDiagnostics: vi.fn(() => unsubscribe) }
    const dispose = ctx.lspDiagnostics.registerProvider(provider as never)
    await ctx.lspDiagnostics.diagnostics({ workspaceRoot: ' /workspace/ ' })
    expect(diagnostics).toHaveBeenCalledWith({ workspaceRoot: '/workspace' }, undefined)
    expect(() => ctx.lspDiagnostics.registerProvider(provider as never)).toThrow()
    dispose()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unsubscribe).toHaveBeenCalledOnce()
    await expect(ctx.lspDiagnostics.diagnostics({ workspaceRoot: '/workspace' }))
      .rejects.toMatchObject({ code: 'LSP_UNAVAILABLE' })
  })
})
