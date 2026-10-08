/**
 * MCP 用户目录模块 - 类型和常量定义
 */

import type { CliMcpSource, McpFileFormat } from "@zcode/shared";

/**
 * MCP 配置键名类型
 * - mcpServers: 通用 JSON 目录格式（.agents/mcp.json）
 * - mcp.servers: zcode CLI config.json 格式
 */
export type McpConfigKeyName = "mcpServers" | "mcp.servers";

export interface McpSourceDescriptor {
  source: CliMcpSource;
  configDirSegments: string[];
  fileName: string;
  format: McpFileFormat;
  configKeyName: McpConfigKeyName;
}

export const MCP_SOURCE_DESCRIPTORS: McpSourceDescriptor[] = [
  {
    source: "zcodeagentmcp",
    // 只描述文件名与格式；实际路径由 index.ts 的 buildDirectoryConfigPath（配合 descriptor.resolveUserBaseDir）
    // 决定：UWork 下是 `<dataRoot>/cli/config.json`，不再写上游 `~/.zcode`。
    configDirSegments: [".uwork", "cli"],
    fileName: "config.json",
    format: "json",
    configKeyName: "mcp.servers",
  },
];

export function getSourceDescriptor(source: CliMcpSource): McpSourceDescriptor {
  const descriptor = MCP_SOURCE_DESCRIPTORS.find((item) => item.source === source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP source: ${source}`);
  }
  return descriptor;
}
