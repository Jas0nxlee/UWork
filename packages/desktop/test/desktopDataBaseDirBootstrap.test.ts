import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractBootstrapDataBaseDir,
  resolveBootstrapSettingsFile,
} from "../src/main/desktopDataBaseDirBootstrap.js";

describe("desktopDataBaseDirBootstrap", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("应从 bootstrap setting 中提取并裁剪 dataBaseDir", () => {
    expect(
      extractBootstrapDataBaseDir({
        dataBaseDir: "  /tmp/zcode-data  ",
      }),
    ).toBe("/tmp/zcode-data");
  });

  it("应忽略无效的 bootstrap 配置", () => {
    expect(extractBootstrapDataBaseDir(null)).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: "" })).toBeNull();
    expect(extractBootstrapDataBaseDir({ dataBaseDir: 123 })).toBeNull();
  });

  it("应拼出默认 bootstrap setting 路径", () => {
    // bootstrap 只接受环境路径；旧 home 参数已移除，不能读到开发机配置。
    vi.stubEnv("UWORK_DATA_BASE_DIR", "");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", "");
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "/Users/tester");
    const result = resolveBootstrapSettingsFile();
    // Windows 下 path.join 使用反斜杠，统一为正斜杠后再比较
    expect(result.replace(/\\/g, "/")).toBe("/Users/tester/.uwork/v2/setting.json");
  });
});
