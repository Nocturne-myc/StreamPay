const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { fixture, create, actual, time } = require('./support/fixture.cjs');

async function balances(f) {
  return Promise.all([f.token.balanceOf(f.sender.address), f.token.balanceOf(f.recipient.address), f.token.balanceOf(await f.escrow.getAddress()), f.escrow.totalLiabilities()]);
}

describe('Partial payments and independent cancellation settlement', function () {
  // Catches overpayment, omitted accounting and lifecycle dependence on claims.
  it('T-S01 pays partial then final entitlement and leaves an Ended zero-liability stream', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f, { amount: 100n });
    await time.setNextBlockTimestamp(a.start + 40n);
    await expect(f.escrow.connect(f.recipient).withdraw(a.id, 25n)).to.emit(f.escrow, 'Withdrawn').withArgs(a.id, f.recipient.address, 25n);
    expect(await f.escrow.withdrawable(a.id)).to.equal(15n);
    expect(await balances(f)).to.deep.equal([999999999900n, 25n, 75n, 75n]);
    await time.setNextBlockTimestamp(a.end);
    await f.escrow.connect(f.recipient).withdraw(a.id, 75n);
    expect(await balances(f)).to.deep.equal([999999999900n, 100n, 0n, 0n]);
    expect((await f.escrow.getStream(a.id)).withdrawn).to.equal(100n);
    expect(await f.escrow.status(a.id)).to.equal(2);
    expect(await f.escrow.withdrawable(a.id)).to.equal(0);
    actual(this, 'Recipient paid 25 then 75; escrow/liability 75 then 0; final status Ended');
  });

  // Catches authorization removal on every settlement entry point.
  it('T-S02 rejects wrong callers for recipient payment, cancellation and refund', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f);
    await time.increaseTo(a.start + 20n);
    for (const caller of [f.sender, f.stranger]) await expect(f.escrow.connect(caller).withdraw(a.id, 1n)).to.be.revertedWithCustomError(f.escrow, 'UnauthorizedRecipient').withArgs(caller.address);
    for (const caller of [f.recipient, f.stranger]) {
      await expect(f.escrow.connect(caller).cancel(a.id)).to.be.revertedWithCustomError(f.escrow, 'UnauthorizedSender').withArgs(caller.address);
      await expect(f.escrow.connect(caller).withdrawRefund(a.id)).to.be.revertedWithCustomError(f.escrow, 'UnauthorizedSender').withArgs(caller.address);
    }
    expect(await balances(f)).to.deep.equal([999999999000n, 0n, 1000n, 1000n]);
    expect((await f.escrow.getStream(a.id)).cancelled).to.equal(false);
    actual(this, 'Six unauthorized mutations reverted with caller-specific role errors; escrow/liability remained 1000');
  });

  // Catches zero-value events and payment beyond current accrued entitlement.
  it('T-S03 rejects zero and excessive recipient withdrawals atomically', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f, { amount: 100n });
    await time.setNextBlockTimestamp(a.start + 20n);
    await expect(f.escrow.connect(f.recipient).withdraw(a.id, 0n)).to.be.revertedWithCustomError(f.escrow, 'InvalidAmount');
    await time.setNextBlockTimestamp(a.start + 21n);
    await expect(f.escrow.connect(f.recipient).withdraw(a.id, 22n)).to.be.revertedWithCustomError(f.escrow, 'InsufficientWithdrawable').withArgs(22n, 21n);
    expect((await f.escrow.getStream(a.id)).withdrawn).to.equal(0);
    expect(await balances(f)).to.deep.equal([999999999900n, 0n, 100n, 100n]);
    actual(this, 'Zero reverted InvalidAmount; 22 requested versus 21 accrued reverted; withdrawn 0, liability 100');
  });

  // Catches zero-initialized phantom settlement records.
  it('T-S04 rejects all mutations on zero and unallocated IDs', async function () {
    const f = await loadFixture(fixture);
    for (const id of [0n, 1n]) {
      await expect(f.escrow.connect(f.recipient).withdraw(id, 1n)).to.be.revertedWithCustomError(f.escrow, 'StreamNotFound').withArgs(id);
      await expect(f.escrow.cancel(id)).to.be.revertedWithCustomError(f.escrow, 'StreamNotFound').withArgs(id);
      await expect(f.escrow.withdrawRefund(id)).to.be.revertedWithCustomError(f.escrow, 'StreamNotFound').withArgs(id);
    }
    expect(await f.escrow.totalLiabilities()).to.equal(0);
    actual(this, 'Six unknown-ID mutations reverted StreamNotFound; liability 0');
  });

  // Catches cancellation paying inline or losing pre-start funds.
  it('T-S05 cancels before start without transfer and permits one full sender refund', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f, { amount: 7n });
    const before = await balances(f);
    await expect(f.escrow.cancel(a.id)).to.emit(f.escrow, 'Cancelled').withArgs(a.id, f.sender.address, 0n, 7n);
    expect(await balances(f)).to.deep.equal(before);
    expect(await f.escrow.refundable(a.id)).to.equal(7);
    await expect(f.escrow.withdrawRefund(a.id)).to.emit(f.escrow, 'RefundWithdrawn').withArgs(a.id, f.sender.address, 7n);
    expect(await balances(f)).to.deep.equal([1000000000000n, 0n, 0n, 0n]);
    expect(await f.escrow.status(a.id)).to.equal(3);
    await expect(f.escrow.withdrawRefund(a.id)).to.be.revertedWithCustomError(f.escrow, 'NoRefund').withArgs(a.id);
    actual(this, 'Pre-start cancellation froze 0 and left balances unchanged; refund paid 7 once; status Cancelled, liability 0');
  });

  // Catches counting the first unit at start rather than after elapsed time.
  it('T-S06 cancellation exactly at start freezes zero recipient accrual', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f, { amount: 100n });
    await time.setNextBlockTimestamp(a.start);
    await f.escrow.cancel(a.id);
    expect(await f.escrow.accrued(a.id)).to.equal(0);
    expect(await f.escrow.refundable(a.id)).to.equal(100);
    expect(await f.escrow.totalLiabilities()).to.equal(100);
    actual(this, 'Cancellation transaction at start froze accrued 0; refund 100; liability remained 100');
  });

  // Catches continued accrual after cancellation or reducing backing prematurely.
  it('T-S07 freezes midstream accrual and keeps liabilities unchanged until claims', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f, { amount: 100n });
    await time.setNextBlockTimestamp(a.start + 40n);
    const before = await balances(f);
    await expect(f.escrow.cancel(a.id)).to.emit(f.escrow, 'Cancelled').withArgs(a.id, f.sender.address, 40n, 60n);
    expect(await balances(f)).to.deep.equal(before);
    await time.increaseTo(a.end + 100n);
    expect(await f.escrow.accrued(a.id)).to.equal(40);
    expect(await f.escrow.withdrawable(a.id)).to.equal(40);
    expect(await f.escrow.refundable(a.id)).to.equal(60);
    expect(await f.escrow.status(a.id)).to.equal(3);
    actual(this, 'Cancellation at +40 froze 40/60 shares; balances/liability stayed 100; same claims after original end+100');
  });

  // Catches non-strict end cancellation and repeated freeze/reset.
  it('T-S08 rejects cancellation at end and repeated cancellation', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f);
    const b = await create(f);
    await f.escrow.cancel(b.id);
    await expect(f.escrow.cancel(b.id)).to.be.revertedWithCustomError(f.escrow, 'AlreadyCancelled').withArgs(b.id);
    await time.setNextBlockTimestamp(a.end);
    await expect(f.escrow.cancel(a.id)).to.be.revertedWithCustomError(f.escrow, 'StreamAlreadyEnded').withArgs(a.id);
    expect((await f.escrow.getStream(a.id)).cancelled).to.equal(false);
    expect(await f.escrow.totalLiabilities()).to.equal(2000);
    actual(this, 'Repeat cancellation reverted AlreadyCancelled; exact-end cancellation reverted StreamAlreadyEnded; liability 2000');
  });

  // Catches an early refund that steals recipient backing.
  it('T-S09 refuses a sender refund before cancellation', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f);
    await expect(f.escrow.withdrawRefund(a.id)).to.be.revertedWithCustomError(f.escrow, 'NoRefund').withArgs(a.id);
    expect(await balances(f)).to.deep.equal([999999999000n, 0n, 1000n, 1000n]);
    actual(this, 'Uncancelled refund reverted NoRefund; all 1000 remained in escrow and liabilities');
  });

  for (const [id, order] of [['T-S10', 'sender-first'], ['T-S11', 'recipient-first']]) {
    // Catches coupling claim rights or subtracting prior withdrawals twice.
    it(`${id} independently settles cancellation after a partial payment (${order})`, async function () {
      const f = await loadFixture(fixture);
      const a = await create(f, { amount: 100n });
      await time.setNextBlockTimestamp(a.start + 20n);
      await f.escrow.connect(f.recipient).withdraw(a.id, 10n);
      await time.setNextBlockTimestamp(a.start + 40n);
      await f.escrow.cancel(a.id);
      expect(await f.escrow.withdrawable(a.id)).to.equal(30);
      expect(await f.escrow.refundable(a.id)).to.equal(60);
      expect(await f.escrow.totalLiabilities()).to.equal(90);
      const recipientClaim = () => f.escrow.connect(f.recipient).withdraw(a.id, 30n);
      const senderClaim = () => f.escrow.withdrawRefund(a.id);
      if (order === 'sender-first') { await senderClaim(); await recipientClaim(); }
      else { await recipientClaim(); await senderClaim(); }
      const s = await f.escrow.getStream(a.id);
      expect(s.withdrawn).to.equal(40);
      expect(s.refunded).to.equal(60);
      expect(s.deposit).to.equal(s.withdrawn + s.refunded);
      expect(await balances(f)).to.deep.equal([999999999960n, 40n, 0n, 0n]);
      expect(await f.escrow.status(a.id)).to.equal(3);
      await expect(f.escrow.withdrawRefund(a.id)).to.be.revertedWithCustomError(f.escrow, 'NoRefund');
      await expect(f.escrow.connect(f.recipient).withdraw(a.id, 1n)).to.be.revertedWithCustomError(f.escrow, 'InsufficientWithdrawable').withArgs(1n, 0n);
      actual(this, `${order}: prior payment 10, frozen accrued 40, recipient remainder 30, refund 60; final liability 0 and Cancelled`);
    });
  }

  // Catches per-second-rate truncation and stranded terminal remainder.
  it('T-S12 accrues literal seven-over-five rounding and pays all seven at end', async function () {
    const f = await loadFixture(fixture);
    const a = await create(f, { amount: 7n, end: BigInt(await time.latest()) + 25n });
    for (const [offset, expected] of [[0n, 0n], [1n, 1n], [2n, 2n], [4n, 5n], [5n, 7n]]) {
      await time.increaseTo(a.start + offset);
      expect(await f.escrow.accrued(a.id)).to.equal(expected);
    }
    await f.escrow.connect(f.recipient).withdraw(a.id, 7n);
    expect(await balances(f)).to.deep.equal([999999999993n, 7n, 0n, 0n]);
    actual(this, 'Deposit 7 / duration 5 accrued [0,1,2,5,7] at [0,1,2,4,5]; recipient received all 7, no residual liability');
  });
});
