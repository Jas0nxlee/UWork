// 保持 extract-zip 消费者的公开 CommonJS 入口；实现只通过这一条边界调用。
module.exports = require("./adapters/extract.cjs");
