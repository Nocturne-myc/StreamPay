const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { fixture, create, actual, ethers, time } = require('./support/fixture.cjs');

describe('Funded creation and query semantics', function () {
  // Catches wrong issuance/scaling or missing funding/accounting/event effects.
  it('T-C01 prefunds streams with six-decimal fixed issuance and consecutive IDs', async function () {
    const f = await loadFixture(fixture);
    expect(await f.token.decimals()).to.equal(6);
    expect(await f.token.totalSupply()).to.equal(1_000_000_000_000n);
    expect(await f.token.balanceOf(f.sender.address)).to.equal(1_000_000_000_000n);
    const a = await create(f);
    await expect(a.tx).to.emit(f.escrow, 'StreamCreated').withArgs(1n, f.sender.address, f.recipient.address, 1000n, a.start, a.end);
    const b = await create(f, { amount: 7n });
    expect(b.id).to.equal(2n);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(1007n);
    expect(await f.token.balanceOf(f.sender.address)).to.equal(999_999_998_993n);
    expect(await f.escrow.totalLiabilities()).to.equal(1007n);
    expect((await f.escrow.getStream(a.id)).deposit).to.equal(1000n);
    actual(this, 'IDs 1,2; escrow balance and liabilities 1007; sender 999999998993; issuance 1000000000000 at 6 decimals');
  });

  // Catches permissive constructor handling of unsupported token interfaces.
  it('T-C02 rejects zero, codeless, reverting and malformed token probes', async function () {
    const f = await loadFixture(fixture);
    const factory = await ethers.getContractFactory('StreamPay');
    for (const address of [ethers.ZeroAddress, f.stranger.address]) {
      await expect(factory.deploy(address)).to.be.revertedWithCustomError(factory, 'InvalidToken').withArgs(address);
    }
    // Runtime fixtures return no ABI word or revert to a balanceOf staticcall.
    for (const runtime of ['0x60006000fd', '0x60016000f3']) {
      await ethers.provider.send('hardhat_setCode', [f.second.address, runtime]);
      await expect(factory.deploy(f.second.address)).to.be.revertedWithCustomError(factory, 'InvalidToken').withArgs(f.second.address);
    }
    actual(this, 'All four constructor screens reverted InvalidToken(address), including 1-byte balanceOf return');
  });

  // Catches strict-now comparison and schedule/status off-by-one branches.
  it('T-C03 accepts creation at transaction start and uses exact lifecycle boundaries', async function () {
    const f = await loadFixture(fixture);
    const start = BigInt(await time.latest()) + 5n;
    await time.setNextBlockTimestamp(start);
    const a = await create(f, { start, end: start + 10n, amount: 100n });
    expect(await f.escrow.status(a.id)).to.equal(1);
    expect(await f.escrow.accrued(a.id)).to.equal(0);
    const b = await create(f, { start: start + 20n, end: start + 30n, amount: 100n });
    await time.increaseTo(start + 19n);
    expect(await f.escrow.status(b.id)).to.equal(0);
    await time.increaseTo(start + 20n);
    expect(await f.escrow.status(b.id)).to.equal(1);
    expect(await f.escrow.accrued(b.id)).to.equal(0);
    await time.increaseTo(start + 21n);
    expect(await f.escrow.accrued(b.id)).to.equal(10);
    await time.increaseTo(start + 29n);
    expect(await f.escrow.accrued(b.id)).to.equal(90);
    await time.increaseTo(start + 30n);
    expect(await f.escrow.status(b.id)).to.equal(2);
    expect(await f.escrow.accrued(b.id)).to.equal(100);
    expect(await f.escrow.withdrawable(b.id)).to.equal(100);
    expect(await f.escrow.refundable(b.id)).to.equal(0);
    actual(this, 'Creation at start succeeded; s-1,s,s+1,e-1,e yielded statuses 0,1,1,1,2 and accrual 0,0,10,90,100');
  });

  // Catches invalid party/amount/time acceptance and phantom accounting.
  it('T-C04 rejects invalid recipients, zero funding and invalid schedules atomically', async function () {
    const f = await loadFixture(fixture);
    const start = BigInt(await time.latest()) + 100n;
    for (const recipient of [ethers.ZeroAddress, f.sender.address, await f.escrow.getAddress()]) {
      await expect(f.escrow.createStream(recipient, 10n, start, start + 10n)).to.be.revertedWithCustomError(f.escrow, 'InvalidRecipient').withArgs(recipient);
    }
    await expect(f.escrow.createStream(f.recipient.address, 0, start, start + 10n)).to.be.revertedWithCustomError(f.escrow, 'InvalidAmount');
    for (const [s, e] of [[start, start], [start, start - 1n], [1n, start]]) {
      await expect(f.escrow.createStream(f.recipient.address, 10n, s, e)).to.be.revertedWithCustomError(f.escrow, 'InvalidSchedule').withArgs(s, e);
    }
    expect(await f.escrow.nextStreamId()).to.equal(1);
    expect(await f.escrow.totalLiabilities()).to.equal(0);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(0);
    actual(this, '7 invalid creations reverted with specified errors; next ID 1 and liabilities/escrow balance 0');
  });

  // Catches updating stream state when the ERC-20 funding call fails.
  it('T-C05 rejects insufficient allowance and balance without allocating an ID', async function () {
    const f = await loadFixture(fixture);
    const start = BigInt(await time.latest()) + 100n;
    await f.token.approve(await f.escrow.getAddress(), 0);
    await expect(f.escrow.createStream(f.recipient.address, 100n, start, start + 20n)).to.be.revertedWithCustomError(f.token, 'ERC20InsufficientAllowance');
    await f.token.approve(await f.escrow.getAddress(), ethers.MaxUint256);
    await expect(f.escrow.createStream(f.recipient.address, 1_000_000_000_001n, start, start + 20n)).to.be.revertedWithCustomError(f.token, 'ERC20InsufficientBalance');
    expect(await f.escrow.nextStreamId()).to.equal(1);
    expect(await f.escrow.totalLiabilities()).to.equal(0);
    expect(await f.token.balanceOf(f.sender.address)).to.equal(1_000_000_000_000n);
    actual(this, 'Allowance and balance failures preserved ID 1, liability 0 and sender balance 1000000000000');
  });

  // Catches default mapping values being treated as real streams.
  it('T-C06 rejects every query for zero and unallocated IDs', async function () {
    const f = await loadFixture(fixture);
    await create(f);
    for (const id of [0n, 2n]) for (const method of ['getStream', 'accrued', 'withdrawable', 'refundable', 'status']) {
      await expect(f.escrow[method](id)).to.be.revertedWithCustomError(f.escrow, 'StreamNotFound').withArgs(id);
    }
    actual(this, '10 queries across IDs 0 and 2 reverted StreamNotFound(id)');
  });
});
