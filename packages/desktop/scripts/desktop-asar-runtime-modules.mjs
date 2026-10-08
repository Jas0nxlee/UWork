// 打包注入与最终校验共享唯一闭包根，避免只更新校验而漏补新依赖的子包。
// collector 按父包解析 dependencies/optionalDependencies，自动带齐真实运行时版本。
export const DESKTOP_ASAR_RUNTIME_MODULES = Object.freeze([
  "module-details-from-path",
  // OTLP exporter 的启动依赖；含 protobufjs 及其递归子依赖。
  "@opentelemetry/api-logs",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  // ARMS 的 peer runtime 和图标编码器，不能依赖开发态 hoist。
  "@babel/runtime",
  "pngjs",
  "undici",
  // 替代 forge 的 CA 编码库；包含 asn1js/pvutils/pvtsutils 等闭包。
  "@peculiar/asn1-schema",
  "@peculiar/asn1-x509",
  // ZIP 压缩/解压链需带齐 buffer-crc32、pend 等叶子包。
  "yazl",
  "yauzl",
  // SSH key parser 与 updater 的运行时依赖。
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  "ms",
]);
