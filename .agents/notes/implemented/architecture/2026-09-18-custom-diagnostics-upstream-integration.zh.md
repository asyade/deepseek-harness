# Agent Note: 自定义诊断与上游 MCP 资源集成

Status: implemented

[English](2026-09-18-custom-diagnostics-upstream-integration.md) | 中文

## Problem

本地诊断包与官方 Harness 版本一起安装时，需要可发现的 schema 和服务文档。MCP 资源也需要唯一的注册所有者，以免产生重复工具。

## Decision

将诊断保留为服务、stdio 提供方和工具消费者。把它们的类型、能力角色、配置和工具 schema 注册到仓库生成器。使用上游 `dsh-mcp-resources` 发现和读取资源；profile 将该服务与 MCP 客户端一起挂载。

## Alternatives considered

在 MCP 客户端中保留资源桥接会重复上游工具注册。移除诊断会丢失已配置的语言服务器错误检查，而上游导航工具不能替代它们。

## Consequences

诊断仍需显式启用。提供方使用已挂载的文件系统和子进程服务，工具负责模型可见的呈现。外部 profile 必须从同一个经过测试的检出目录解析这些包。聚焦服务测试和真实 TypeScript 错误/修复探针覆盖注册与诊断刷新；MCP 资源测试覆盖上游资源工具。
