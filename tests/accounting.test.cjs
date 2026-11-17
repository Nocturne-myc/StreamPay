const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { fixture, create, actual, ethers, time } = require('./support/fixture.cjs');
const { reference, model } = require('./support/reference.cjs');

const traceFile = path.resolve(__dirname, '../evidence/random-traces.json');
const campaigns = [];
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
function saveTraces() {
  fs.mkdirSync(path.dirname(traceFile), { recursive: true });
  fs.writeFileSync(traceFile, json({ scope: 'Local Hardhat deterministic action campaigns; independent intended-action BigInt model', campaigns }) + '\n');
}
function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

describe('Independent accounting and deterministic campaigns', function () {
  // Catches cross-stream claims, donation entitlement and missing terminal dust.
  it('T-A13 interleaves four streams and leaves donations as surplus only', async function () {
    const f = await loadFixture(fixture);
    const start = BigInt(await time.latest()) + 30n;
    const streams = [];
    for (const [amount, duration] of [[7n, 5n], [100n, 100n], [1n, 3n], [9n, 9n]]) streams.push(await create(f, { amount, start, end: start + duration }));
    expect(await f.escrow.totalLiabilities()).to.equal(117n);
    await time.setNextBlockTimestamp(start + 2n);
    await f.escrow.connect(f.recipient).withdraw(streams[0].id, 2n);
    await f.token.transfer(await f.escrow.getAddress(), 31n);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(146n);
    expect(await f.escrow.totalLiabilities()).to.equal(115n);
    await time.setNextBlockTimestamp(start + 40n);
    await f.escrow.cancel(streams[1].id);
    expect(await f.escrow.withdrawable(streams[1].id)).to.equal(40n);
    expect(await f.escrow.refundable(streams[1].id)).to.equal(60n);
    expect(await f.escrow.totalLiabilities()).to.equal(115n);
    await f.escrow.withdrawRefund(streams[1].id);
    for (const [index, amount] of [[0, 5n], [1, 40n], [2, 1n], [3, 9n]]) await f.escrow.connect(f.recipient).withdraw(streams[index].id, amount);
    expect(await f.escrow.totalLiabilities()).to.equal(0n);
    expect(await f.token.balanceOf(await f.escrow.getAddress())).to.equal(31n);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(57n);
    expect(await f.token.balanceOf(f.sender.address)).to.equal(999999999912n);
    for (const stream of streams) {
      const s = await f.escrow.getStream(stream.id);
      expect(s.deposit).to.equal(s.withdrawn + s.refunded);
      expect(await f.escrow.withdrawable(stream.id)).to.equal(0);
      expect(await f.escrow.refundable(stream.id)).to.equal(0);
      await expect(f.escrow.connect(f.recipient).withdraw(stream.id, 1n)).to.be.revertedWithCustomError(f.escrow, 'InsufficientWithdrawable').withArgs(1n, 0n);
    }
    actual(this, 'Four deposits 7+100+1+9=117; recipient paid 57, sender refunded 60; all liabilities 0; donated 31 remains unclaimable surplus');
  });

  for (const [caseId, seed] of [['T-A14', 17], ['T-A15', 5760], ['T-A16', 21346213]]) {
    // Catches state/accounting divergence under ordered mixed actions. The
    // model evolves from intended actions, never from contract query results.
    it(`${caseId} matches an independent BigInt model over 80 actions (seed ${seed})`, async function () {
      const f = await loadFixture(fixture);
      const escrowAddress = await f.escrow.getAddress();
      await f.token.transfer(f.second.address, 10_000n);
      await f.token.connect(f.second).approve(escrowAddress, ethers.MaxUint256);
      const signers = [f.sender, f.recipient, f.stranger, f.second];
      const byAddress = new Map(signers.map(account => [account.address, account]));
      const base = BigInt(await time.latest()) + 25n;
      const models = [];
      for (let index = 0; index < 4; index++) {
        const sender = index % 2 ? f.second : f.sender;
        const recipient = index % 2 ? f.stranger : f.recipient;
        const deposit = [101n, 7n, 1n, 999n][index];
        const start = base + BigInt(index * 3);
        const end = start + [101n, 5n, 31n, 199n][index];
        const id = await f.escrow.nextStreamId();
        await f.escrow.connect(sender).createStream(recipient.address, deposit, start, end);
        models.push(model({ id, sender: sender.address, recipient: recipient.address, deposit, start, end }));
      }
      const balances = new Map(await Promise.all(signers.map(async account => [account.address, await f.token.balanceOf(account.address)])));
      let holdings = 1108n;
      let donations = 0n;
      const rng = random(seed);
      const campaign = { caseId, seed, actionsRequested: 80, streamCount: 4, initialStreams: structuredClone(models), actions: [], passed: false };
      campaigns.push(campaign);

      async function compare(at) {
        let liability = 0n;
        const observed = [];
        for (const m of models) {
          const expected = reference(m, at);
          const s = await f.escrow.getStream(m.id);
          expect(await f.escrow.accrued(m.id)).to.equal(expected.accrued);
          expect(await f.escrow.withdrawable(m.id)).to.equal(expected.withdrawable);
          expect(await f.escrow.refundable(m.id)).to.equal(expected.refundable);
          expect(s.withdrawn).to.equal(m.withdrawn);
          expect(s.refunded).to.equal(m.refunded);
          expect(s.cancelled).to.equal(m.cancelledAt !== null);
          if (m.cancelledAt !== null) expect(s.accruedAtCancellation).to.equal(expected.accrued);
          const status = m.cancelledAt !== null ? 3 : at < m.start ? 0 : at >= m.end ? 2 : 1;
          expect(await f.escrow.status(m.id)).to.equal(status);
          expect(m.deposit).to.equal(m.withdrawn + m.refunded + expected.liability);
          liability += expected.liability;
          observed.push({ id: m.id, ...expected });
        }
        expect(await f.escrow.totalLiabilities()).to.equal(liability);
        expect(await f.token.balanceOf(escrowAddress)).to.equal(holdings);
        expect(holdings).to.equal(liability + donations);
        expect(holdings).to.be.at.least(liability);
        for (const [address, expected] of balances) expect(await f.token.balanceOf(address)).to.equal(expected);
        return { streams: observed, aggregateLiability: liability, escrowBalance: holdings, surplus: donations, accountBalances: Object.fromEntries(balances) };
      }
      await compare(BigInt(await time.latest()));
      try {
        for (let index = 0; index < 80; index++) {
          const m = models[rng() % 4];
          const action = rng() % 6;
          const at = BigInt(await time.latest()) + 1n;
          const row = { index, id: m.id, action: ['advance', 'valid-claim', 'invalid-claim', 'cancel', 'refund', 'donation'][action], timestamp: at };
          campaign.actions.push(row);
          if (action === 0) {
            const seconds = BigInt(rng() % 8 + 1);
            await time.increaseTo(at + seconds);
            row.timestamp = BigInt(await time.latest());
            row.seconds = seconds + 1n;
            row.result = 'time advanced';
          } else {
            await time.setNextBlockTimestamp(at);
            const expected = reference(m, at);
            const sender = f.escrow.connect(byAddress.get(m.sender));
            const recipient = f.escrow.connect(byAddress.get(m.recipient));
            if (action === 1 || action === 2) {
              const draw = BigInt(rng() % 7 + 1);
              const bounded = action === 2 ? expected.withdrawable + 1n
                : expected.withdrawable === 0n ? 1n
                : draw < expected.withdrawable ? draw : expected.withdrawable;
              row.amount = bounded;
              if (bounded > expected.withdrawable) {
                await expect(recipient.withdraw(m.id, bounded, { gasLimit: 500000 })).to.be.revertedWithCustomError(f.escrow, 'InsufficientWithdrawable').withArgs(bounded, expected.withdrawable);
                row.result = 'expected InsufficientWithdrawable';
              } else {
                await (await recipient.withdraw(m.id, bounded, { gasLimit: 500000 })).wait();
                m.withdrawn += bounded;
                balances.set(m.recipient, balances.get(m.recipient) + bounded);
                holdings -= bounded;
                row.result = 'recipient paid';
              }
            } else if (action === 3) {
              if (m.cancelledAt !== null) {
                await expect(sender.cancel(m.id, { gasLimit: 500000 })).to.be.revertedWithCustomError(f.escrow, 'AlreadyCancelled');
                row.result = 'expected AlreadyCancelled';
              } else if (at >= m.end) {
                await expect(sender.cancel(m.id, { gasLimit: 500000 })).to.be.revertedWithCustomError(f.escrow, 'StreamAlreadyEnded');
                row.result = 'expected StreamAlreadyEnded';
              } else {
                await (await sender.cancel(m.id, { gasLimit: 500000 })).wait();
                m.cancelledAt = at;
                row.result = 'accrual frozen';
              }
            } else if (action === 4) {
              if (expected.refundable === 0n) {
                await expect(sender.withdrawRefund(m.id, { gasLimit: 500000 })).to.be.revertedWithCustomError(f.escrow, 'NoRefund');
                row.result = 'expected NoRefund';
              } else {
                await (await sender.withdrawRefund(m.id, { gasLimit: 500000 })).wait();
                m.refunded += expected.refundable;
                balances.set(m.sender, balances.get(m.sender) + expected.refundable);
                holdings -= expected.refundable;
                row.amount = expected.refundable;
                row.result = 'sender refunded';
              }
            } else {
              const amount = BigInt(rng() % 11 + 1);
              await (await f.token.transfer(escrowAddress, amount)).wait();
              balances.set(f.sender.address, balances.get(f.sender.address) - amount);
              holdings += amount;
              donations += amount;
              row.amount = amount;
              row.result = 'surplus donation';
            }
          }
          const observedTime = BigInt(await time.latest());
          expect(observedTime).to.equal(row.timestamp);
          row.after = await compare(observedTime);
        }
        campaign.passed = true;
        campaign.final = campaign.actions.at(-1).after;
        saveTraces();
        const counts = Object.fromEntries([...new Set(campaign.actions.map(row => row.action))].map(action => [action, campaign.actions.filter(row => row.action === action).length]));
        actual(this, `Seed ${seed}: 80/80 actions across 4 streams; ${JSON.stringify(counts)}; final liabilities ${campaign.final.aggregateLiability}, holdings ${campaign.final.escrowBalance}, surplus ${campaign.final.surplus}`);
      } catch (error) {
        campaign.failure = error.message;
        saveTraces();
        throw new Error(`Seed ${seed} failed at action ${campaign.actions.length - 1}: ${error.message}\nTrace: ${json(campaign.actions.at(-1))}`, { cause: error });
      }
    });
  }
});
