/**
 * 线协议常量：两端（宿主路由与 M2 客户端）共用的唯一来源。
 * @module dsh-prompt-forge/protocol
 */

/** 路由前缀与端点。 */
export const PROTOCOL = {
  /** webserver 的 prefix 注册路径。 */
  prefix: '/prompt-forge',
  /** 一次性 JSON。 */
  endpoint: '/prompt-forge/enhance',
  /** SSE 增量。 */
  streamEndpoint: '/prompt-forge/enhance/stream',
  /** 只读状态：客户端据此决定按钮是否显示、候选数、快捷键与输入上限。 */
  stateEndpoint: '/prompt-forge/state',
  /** 运行期配置：GET 读有效配置与覆盖层，POST 写覆盖层。 */
  configEndpoint: '/prompt-forge/config',
  /** 协议版本：两端随包发版，不一致时客户端只告警不阻断。 */
  version: 1,
}

/** 本条目的插件行 id（patch 里 insert 的 id）。 */
export const ROW_ID = 'prompt-forge'

/** 线协议错误码，与现役插件保持同一套，便于迁移期共用文档与文案。 */
export const ERROR_CODES = [
  'rejected',
  'rate-limit',
  'concurrency-limit',
  'cooldown',
  'timeout',
  'unconfigured',
  'upstream',
  'internal',
]
