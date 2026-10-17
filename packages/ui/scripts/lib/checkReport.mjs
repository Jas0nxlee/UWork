/**
 * 检查脚本的**公共断言/进度输出**（几个 office 检查都在用同一套）。
 * 抽出来的原因：每个脚本都重写一遍"ok/FAIL + 失败计数 + 阶段计时"，既容易漂，也占行数。
 */
export function createReport() {
  const failures = [];
  const started = Date.now();
  return {
    failures,
    check(ok, message) {
      if (ok) console.log(`ok   ${message}`);
      else {
        console.log(`FAIL ${message}`);
        failures.push(message);
      }
    },
    /** 阶段计时：卡住时能看出卡在哪一步（打产物 / 页面就绪 / …）。 */
    stage(name) {
      console.log(`… ${name}（${Math.round((Date.now() - started) / 1000)}s）`);
    },
    finish(summary) {
      if (failures.length > 0) {
        console.log(`\n${failures.length} 条未通过`);
        process.exitCode = 1;
        return;
      }
      console.log(`\n${summary}`);
    },
  };
}
