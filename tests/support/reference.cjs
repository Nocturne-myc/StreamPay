/** Independent integer model: intended actions own this state; no contract reads. */
function reference(model, timestamp) {
  const t = BigInt(timestamp);
  const cutoff = model.cancelledAt === null ? t : model.cancelledAt;
  const elapsed = cutoff <= model.start ? 0n : cutoff >= model.end ? model.end - model.start : cutoff - model.start;
  const accrued = model.deposit * elapsed / (model.end - model.start);
  return {
    accrued,
    withdrawable: accrued - model.withdrawn,
    refundable: model.cancelledAt === null ? 0n : model.deposit - accrued - model.refunded,
    liability: model.deposit - model.withdrawn - model.refunded
  };
}
function model({ id, sender, recipient, deposit, start, end }) {
  return { id, sender, recipient, deposit, start, end, withdrawn: 0n, refunded: 0n, cancelledAt: null };
}
module.exports = { reference, model };
