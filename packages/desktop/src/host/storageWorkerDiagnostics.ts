/** stderr 可能带本机路径或凭据，诊断只能返回固定分类，禁止返回匹配内容。 */
export function classifyStorageWorkerStderr(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["cwd-inaccessible", /--cwd path is not accessible:/],
    ["worker-api", /not supported in workers|process\.(?:chdir|umask|title)|线程/i],
    ["module-loader", /cannot find module|dynamic require|require is not defined|module did not/i],
    ["configuration", /config|validation|zod|environment|配置|环境|校验/i],
    ["arguments", /option|argument|unknown command|参数|选项|命令|语言/i],
    ["filesystem", /EACCES|ENOENT|ENOTDIR|EPERM|SQLITE|database|文件|目录|数据库|权限/i],
    ["model-provider", /provider|model|api key|供应商|模型|密钥/i],
    ["network", /fetch|ECONN|certificate|TLS/i],
    ["unexpected-syntax", /unexpected|syntaxerror/i],
    ["authentication", /unauthorized|authentication|登录|鉴权|认证/i],
    ["stream-io", /stdin|stdout|stderr|EPIPE|socket|stream|pipe/i],
    ["runtime-type", /TypeError|not a function|read.only|getter|redefine|undefined|null/i],
    ["unsupported-runtime", /unsupported|not supported|version|版本|不支持/i],
    ["assertion", /expected|received|must|assert/i],
    ["worker-transfer", /clone|transfer|port|serializ/i],
    ["numeric-encoded", /^\d+(?:,\d+)+$/],
  ];
  const match = patterns.find(([, pattern]) => pattern.test(text));
  return match ? [match[0]] : [];
}
