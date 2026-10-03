'use strict';
// 模拟支付适配器:内存网关,按幂等键去重;真正的持久化在 payments 表
function createPayment() {
  const charges = new Map();
  const refunds = new Map();
  return {
    charge(idempotencyKey, amountCents) {
      if (charges.has(idempotencyKey)) return charges.get(idempotencyKey);
      const tx = { transaction_id: `pay_${idempotencyKey}`, amount_cents: amountCents, status: 'succeeded' };
      charges.set(idempotencyKey, tx);
      return tx;
    },
    refund(idempotencyKey, amountCents) {
      if (refunds.has(idempotencyKey)) return refunds.get(idempotencyKey);
      const tx = { refund_id: `rf_${idempotencyKey}`, amount_cents: amountCents, status: 'succeeded' };
      refunds.set(idempotencyKey, tx);
      return tx;
    },
    // 测试用:统计调用次数
    _stats: { charges, refunds },
  };
}

module.exports = { createPayment };
