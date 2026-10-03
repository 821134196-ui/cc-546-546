'use strict';
// 模拟打印适配器:不写真实打印机,追加到 var/print-spool.log 并返回作业号
const fs = require('node:fs');
const path = require('node:path');

function createPrinter(spoolPath) {
  fs.mkdirSync(path.dirname(spoolPath), { recursive: true });
  let counter = 0;
  return {
    print(job) {
      counter += 1;
      const record = { job_id: `PRT-${Date.now()}-${counter}`, printed_at: new Date().toISOString(), ...job };
      fs.appendFileSync(spoolPath, JSON.stringify(record) + '\n');
      return { ok: true, job_id: record.job_id };
    },
  };
}

module.exports = { createPrinter };
