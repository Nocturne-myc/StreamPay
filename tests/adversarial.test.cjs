const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { actual, ethers, time } = require('./support/fixture.cjs');

async function hostile(supply = 1_000_000n) {
  const [sender, recipient, stranger] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory('AdversarialToken')).deploy(supply);
  const escrow = await (await ethers.getContractFactory('StreamPay')).deploy(await token.getAddress());
  await token.approve(await escrow.getAddress(), ethers.MaxUint256);
  return { sender, recipient, stranger, token, escrow };
}
async function hcreate(f, options = {}) {
  const start = options.start ?? BigInt(await time.latest()) + 30n;
  const end = options.end ?? start + 100n;
  const amount = options.amount ?? 100n;
  const recipient = options.recipient ?? f.recipient.address;
  const id = await f.escrow.nextStreamId();
  await f.escrow.createStream(recipient, amount, start, end);
  return { id, start, end, amount };
}
async function snapshot(f, ids) {
  return {
    balances: await Promise.all([f.token.balanceOf(f.sender.address), f.token.balanceOf(f.recipient.address), f.token.balanceOf(await f.escrow.getAddress()), f.token.balanceOf(await f.token.getAddress())]),
    liability: await f.escrow.totalLiabilities(), next: await f.escrow.nextStreamId(),
    supply: await f.token.totalSupply(), allowance: await f.token.allowance(f.sender.address, await f.escrow.getAddress()),
    streams: await Promise.all(ids.map(id => f.escrow.getStream(id)))
  };
}
async function proxy(f, data) { return f.token.proxy(await f.escrow.getAddress(), data); }

// Malicious and unusually large-supply tokens below are test fixtures, not the
// fixed-supply assessed token and not a supported arbitrary-token integration.
describe('Adversarial token fixtures', function () {
  // Catches accepting a short or negative observed balance delta as funding.
  it('T-A01 rejects short and decreasing incoming funding with complete rollback', async function () {
    const f = await hostile();
    await f.token.transfer(await f.escrow.getAddress(), 10n); // Existing surplus.
    const start = BigInt(await time.latest()) + 100n;
    for (const [mode, after] of [[1, 109n], [2, 9n]]) {
      await f.token.setIncomingMode(mode);
      const before = await snapshot(f, []);
      await expect(f.escrow.createStream(f.recipient.address, 100n, start, start + 100n)).to.be.revertedWithCustomError(f.escrow, 'InexactFunding').withArgs(100n, 10n, after);
      expect(await snapshot(f, [])).to.deep.equal(before);
    }
    actual(this, 'Funding deltas +99 and -1 rejected as InexactFunding(100,10,109/9); balances, next ID and liability rolled back');
  });

  // Catches recording funding when transferFrom returns false or reverts.
  it('T-A02 rolls back false and reverting transferFrom calls', async function () {
    const f = await hostile();
    const start = BigInt(await time.latest()) + 100n;
    for (const mode of [3, 4]) {
      await f.token.setIncomingMode(mode);
      const before = await snapshot(f, []);
      const attempt = f.escrow.createStream(f.recipient.address, 100n, start, start + 100n);
      if (mode === 3) await expect(attempt).to.be.revertedWithCustomError(f.escrow, 'SafeERC20FailedOperation').withArgs(await f.token.getAddress());
      else await expect(attempt).to.be.revertedWithCustomError(f.token, 'FixtureTransferRejected');
      expect(await snapshot(f, [])).to.deep.equal(before);
    }
    actual(this, 'False/reverting transferFrom rejected; sender/escrow balances, liability 0 and next ID 1 unchanged');
  });

  // Catches CEI state persisting after an outgoing token failure.
  it('T-A03 restores recipient claim state on false and reverting transfer', async function () {
    const f = await hostile();
    const a = await hcreate(f);
    await time.increaseTo(a.end);
    for (const mode of [1, 2]) {
      await f.token.setOutgoingMode(mode, f.recipient.address);
      const before = await snapshot(f, [a.id]);
      const attempt = f.escrow.connect(f.recipient).withdraw(a.id, 30n);
      if (mode === 1) await expect(attempt).to.be.revertedWithCustomError(f.escrow, 'SafeERC20FailedOperation');
      else await expect(attempt).to.be.revertedWithCustomError(f.token, 'FixtureTransferRejected');
      expect(await snapshot(f, [a.id])).to.deep.equal(before);
    }
    await f.token.setOutgoingMode(0, ethers.ZeroAddress);
    await f.escrow.connect(f.recipient).withdraw(a.id, 100n);
    expect(await f.escrow.totalLiabilities()).to.equal(0);
    actual(this, 'Two failed recipient transfers preserved all stream fields and balances; later successful payment 100 cleared liability');
  });

  // Catches inline cancellation transfers or coupling the sender's refund to a recipient failure.
  it('T-A04 a failed recipient transfer cannot prevent cancellation or sender refund', async function () {
    const f = await hostile();
    const a = await hcreate(f);
    await f.token.setOutgoingMode(2, f.recipient.address);
    await time.setNextBlockTimestamp(a.start + 40n);
    await f.escrow.cancel(a.id);
    const before = await snapshot(f, [a.id]);
    await expect(f.escrow.connect(f.recipient).withdraw(a.id, 40n)).to.be.revertedWithCustomError(f.token, 'FixtureTransferRejected');
    expect(await snapshot(f, [a.id])).to.deep.equal(before);
    await f.escrow.withdrawRefund(a.id);
    expect(await f.token.balanceOf(f.sender.address)).to.equal(999960n);
    expect(await f.escrow.totalLiabilities()).to.equal(40);
    expect(await f.escrow.withdrawable(a.id)).to.equal(40);
    actual(this, 'Blocked recipient payment rolled back; sender independently received 60; recipient claim/liability remained 40');
  });

  // Catches coupling earned recipient funds to the sender's failed refund.
  it('T-A05 a failed sender refund cannot prevent the earned recipient payment', async function () {
    const f = await hostile();
    const a = await hcreate(f);
    await time.setNextBlockTimestamp(a.start + 40n);
    await f.escrow.cancel(a.id);
    await f.token.setOutgoingMode(1, f.sender.address);
    const before = await snapshot(f, [a.id]);
    await expect(f.escrow.withdrawRefund(a.id)).to.be.revertedWithCustomError(f.escrow, 'SafeERC20FailedOperation');
    expect(await snapshot(f, [a.id])).to.deep.equal(before);
    await f.escrow.connect(f.recipient).withdraw(a.id, 40n);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(40);
    expect(await f.escrow.refundable(a.id)).to.equal(60);
    expect(await f.escrow.totalLiabilities()).to.equal(60);
    actual(this, 'Blocked sender refund rolled back; recipient independently received 40; refund/liability remained 60');
  });

  // Catches truncation to a per-second rate for a one-unit stream.
  it('T-A06 one-unit deposits remain claimable in full at end and zero deposits are rejected', async function () {
    const f = await hostile();
    const start = BigInt(await time.latest()) + 20n;
    await expect(f.escrow.createStream(f.recipient.address, 0n, start, start + 3n)).to.be.revertedWithCustomError(f.escrow, 'InvalidAmount');
    const a = await hcreate(f, { amount: 1n, start, end: start + 3n });
    await time.increaseTo(a.end - 1n);
    expect(await f.escrow.accrued(a.id)).to.equal(0);
    await time.setNextBlockTimestamp(a.end);
    await f.escrow.connect(f.recipient).withdraw(a.id, 1n);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(1);
    expect(await f.escrow.totalLiabilities()).to.equal(0);
    actual(this, 'Zero rejected; deposit 1 accrued 0 at end-1 and paid exactly 1 at end; liability 0');
  });

  // Catches intermediate multiplication overflow instead of full-precision mulDiv.
  it('T-A07 large-supply fixture accrues 2**254+3 at midpoint without overflow', async function () {
    const deposit = 2n ** 255n + 7n;
    const midpoint = 2n ** 254n + 3n;
    const f = await hostile(deposit);
    const a = await hcreate(f, { amount: deposit });
    await time.setNextBlockTimestamp(a.start + 50n);
    await f.escrow.connect(f.recipient).withdraw(a.id, midpoint);
    expect(await f.escrow.accrued(a.id)).to.equal(midpoint);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(midpoint);
    expect(await f.escrow.totalLiabilities()).to.equal(deposit - midpoint);
    await time.setNextBlockTimestamp(a.end);
    await f.escrow.connect(f.recipient).withdraw(a.id, deposit - midpoint);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(deposit);
    expect(await f.escrow.totalLiabilities()).to.equal(0);
    actual(this, `Fixture deposit ${deposit}; midpoint paid ${midpoint}; final full payout, liability 0`);
  });

  for (const [caseId, operation] of [['T-A08', 'create'], ['T-A09', 'cancel'], ['T-A10', 'withdraw'], ['T-A11', 'refund']]) {
    // Catches removing nonReentrant from each mutable entry point; the nested
    // token actor owns the role, allowance/balance and positive claim required.
    it(`${caseId} rejects an authorized nested ${operation} with the reentrancy selector`, async function () {
      const f = await hostile();
      const tokenAddress = await f.token.getAddress();
      const escrowAddress = await f.escrow.getAddress();
      await f.token.transfer(tokenAddress, 1000n);
      await f.token.proxy(tokenAddress, f.token.interface.encodeFunctionData('approve', [escrowAddress, ethers.MaxUint256]));
      const outer = await hcreate(f);
      const now = BigInt(await time.latest());
      let nestedId;
      let data;
      if (operation === 'create') {
        data = f.escrow.interface.encodeFunctionData('createStream', [f.stranger.address, 10n, outer.start + 200n, outer.start + 300n]);
      } else if (operation === 'withdraw') {
        const nested = await hcreate(f, { recipient: tokenAddress, start: now + 10n, end: now + 110n });
        nestedId = nested.id;
        data = f.escrow.interface.encodeFunctionData('withdraw', [nestedId, 1n]);
      } else {
        nestedId = await f.escrow.nextStreamId();
        await proxy(f, f.escrow.interface.encodeFunctionData('createStream', [f.stranger.address, 100n, outer.start, outer.end + 100n]));
        if (operation === 'refund') await proxy(f, f.escrow.interface.encodeFunctionData('cancel', [nestedId]));
        data = f.escrow.interface.encodeFunctionData(operation === 'refund' ? 'withdrawRefund' : 'cancel', [nestedId]);
      }
      await time.increaseTo(outer.start + 50n);
      if (operation === 'withdraw') expect(await f.escrow.withdrawable(nestedId)).to.be.greaterThan(0n);
      if (operation === 'refund') expect(await f.escrow.refundable(nestedId)).to.equal(100n);
      const before = await snapshot(f, nestedId ? [outer.id, nestedId] : [outer.id]);
      await f.token.configureCallback(escrowAddress, data, false, 2);
      await f.escrow.connect(f.recipient).withdraw(outer.id, 10n);
      expect(await f.token.lastCallbackSuccess()).to.equal(false);
      expect(await f.token.lastCallbackResult()).to.equal(ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10));
      const after = await snapshot(f, nestedId ? [outer.id, nestedId] : [outer.id]);
      expect(after.next).to.equal(before.next);
      expect(after.liability).to.equal(before.liability - 10n);
      expect(after.balances[1]).to.equal(before.balances[1] + 10n);
      expect(after.balances[2]).to.equal(before.balances[2] - 10n);
      if (nestedId) expect(after.streams[1]).to.deep.equal(before.streams[1]);
      // With the callback disabled the identical actor/data succeeds, proving
      // the nested operation was viable and its rejection came from the guard.
      await f.token.configureCallback(ethers.ZeroAddress, '0x', false, 0);
      await proxy(f, data);
      actual(this, `Authorized nested ${operation} rejected with ${ethers.id('ReentrancyGuardReentrantCall()').slice(0, 10)}; outer paid 10 once; identical actor call later succeeded`);
    });
  }

  // Catches state/balance effects surviving a callback propagated to the caller.
  it('T-A12 propagated callback failure restores outer and nested balances and accounting', async function () {
    const f = await hostile();
    const outer = await hcreate(f);
    const nested = await hcreate(f, { recipient: await f.token.getAddress(), start: outer.start, end: outer.end });
    await time.increaseTo(outer.start + 50n);
    expect(await f.escrow.withdrawable(nested.id)).to.be.greaterThan(1n);
    const data = f.escrow.interface.encodeFunctionData('withdraw', [nested.id, 1n]);
    await f.token.configureCallback(await f.escrow.getAddress(), data, true, 2);
    const before = await snapshot(f, [outer.id, nested.id]);
    await expect(f.escrow.connect(f.recipient).withdraw(outer.id, 10n)).to.be.revertedWithCustomError(f.escrow, 'ReentrancyGuardReentrantCall');
    expect(await snapshot(f, [outer.id, nested.id])).to.deep.equal(before);
    await f.token.configureCallback(ethers.ZeroAddress, '0x', false, 0);
    await proxy(f, data);
    expect(await f.token.balanceOf(await f.token.getAddress())).to.equal(1n);
    actual(this, 'Propagated authorized nested withdrawal reverted ReentrancyGuardReentrantCall; both streams/balances unchanged; nested claim later paid 1');
  });
});
