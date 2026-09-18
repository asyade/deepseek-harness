# Agent Note: Custom diagnostics alongside upstream MCP resources

Status: implemented

English | [中文](2026-09-18-custom-diagnostics-upstream-integration.zh.md)

## Problem

The local diagnostics packages need discoverable schemas and service documentation when installed with official Harness releases. MCP resources also need one registration owner to avoid duplicate tools.

## Decision

Keep diagnostics as a service, a stdio provider, and a tool consumer. Register their types, capability roles, configuration, and tool schemas with the repository generators. Use upstream `dsh-mcp-resources` for resource discovery and reads; profiles mount that service beside their MCP clients.

## Alternatives considered

Keeping a resource bridge inside the MCP client duplicates upstream tool registration. Removing diagnostics would discard the configured language-server error checks, which upstream navigation tools do not replace.

## Consequences

Diagnostics remain opt-in. Their providers use the mounted filesystem and subprocess services, while the tool owns model-visible rendering. External profiles must resolve these packages from the same tested checkout. Focused service tests and a real TypeScript error/fix probe cover registration and refreshed diagnostics; MCP resource tests cover the upstream resource tools.
