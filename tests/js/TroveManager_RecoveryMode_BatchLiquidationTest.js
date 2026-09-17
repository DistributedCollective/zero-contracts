const deploymentHelper = require("../../utils/js/deploymentHelpers.js");
const testHelpers = require("../../utils/js/testHelpers.js");

const th = testHelpers.TestHelper;
const mv = testHelpers.MoneyValues;
const { toBN, dec } = th;
const ZERO_ADDRESS = th.ZERO_ADDRESS || "0x0000000000000000000000000000000000000000";

const TroveManagerTester = artifacts.require("./TroveManagerTester");
const ZUSDToken = artifacts.require("./ZUSDToken.sol");

/*
 * Ported from Liquity's TroveManager_RecoveryMode_Batch_Liqudation_Test.js
 * (liquity/dev, fix commits b9dcdbd3 2021-05-19 and 47fb4d56 2021-09-03).
 *
 * Covers the running system-collateral tracker used by the Recovery Mode
 * liquidation loops. Before the fix, _getTotalFromBatchLiquidate_RecoveryMode
 * only subtracted collToSendToSP, so after a capped liquidation the TCR seen by
 * the next trove in the batch was too high and a trove above the real TCR could
 * be liquidated ("A trove over TCR is not liquidated" fails on the old code).
 */
contract("TroveManager - in Recovery Mode - back to normal mode in 1 tx", async accounts => {
  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000);
  const [owner, alice, bob, carol, dennis, erin, freddy, greta, harry, ida, whale] = accounts;

  let contracts;
  let troveManager;
  let stabilityPool;
  let priceFeed;
  let sortedTroves;

  const openTrove = async params => th.openTrove(contracts, params);

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore();
    contracts.troveManager = await TroveManagerTester.new(contracts.permit2.address);
    contracts.zusdToken = await ZUSDToken.new();
    await contracts.zusdToken.initialize(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    );
    const ZEROContracts = await deploymentHelper.deployZEROContracts(multisig);

    troveManager = contracts.troveManager;
    stabilityPool = contracts.stabilityPool;
    priceFeed = contracts.priceFeedTestnet;
    sortedTroves = contracts.sortedTroves;

    await deploymentHelper.connectZEROContracts(ZEROContracts);
    await deploymentHelper.connectCoreContracts(contracts, ZEROContracts);
    await deploymentHelper.connectZEROContractsToCore(ZEROContracts, contracts);
  });

  context("Batch liquidations", () => {
    const setup = async () => {
      const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(296, 16)), extraParams: { from: alice } });
      const { collateral: B_coll, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(280, 16)), extraParams: { from: bob } });
      const { collateral: C_coll, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: carol } });

      const totalLiquidatedDebt = A_totalDebt.add(B_totalDebt).add(C_totalDebt);
      const spDeposit = totalLiquidatedDebt.add(toBN(dec(1, 18)));

      await openTrove({ ICR: toBN(dec(340, 16)), extraZUSDAmount: spDeposit, extraParams: { from: whale } });
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();
      const TCR = await th.getTCR(contracts);

      // Check Recovery Mode is active
      assert.isTrue(await th.checkRecoveryMode(contracts));

      // Check troves A, B are in range 110% < ICR < TCR, C is below 100%
      const ICR_A = await troveManager.getCurrentICR(alice, price);
      const ICR_B = await troveManager.getCurrentICR(bob, price);
      const ICR_C = await troveManager.getCurrentICR(carol, price);

      assert.isTrue(ICR_A.gt(mv._MCR) && ICR_A.lt(TCR));
      assert.isTrue(ICR_B.gt(mv._MCR) && ICR_B.lt(TCR));
      assert.isTrue(ICR_C.lt(mv._ICR100));

      return { A_coll, A_totalDebt, B_coll, B_totalDebt, C_coll, C_totalDebt, totalLiquidatedDebt, price };
    };

    it("First trove only doesn't get out of Recovery Mode", async () => {
      await setup();
      await troveManager.batchLiquidateTroves([alice]);
      assert.isTrue(await th.checkRecoveryMode(contracts));
    });

    it("Two troves over MCR are liquidated", async () => {
      await setup();
      const tx = await troveManager.batchLiquidateTroves([alice, bob, carol]);

      const liquidationEvents = th.getAllEventsByName(tx, "TroveLiquidated");
      assert.equal(liquidationEvents.length, 3, "Not enough liquidations");

      assert.isFalse(await sortedTroves.contains(alice));
      assert.isFalse(await sortedTroves.contains(bob));
      assert.isFalse(await sortedTroves.contains(carol));

      // Status enum element idx 3 = closed by liquidation
      assert.equal((await troveManager.Troves(alice))[3], "3");
      assert.equal((await troveManager.Troves(bob))[3], "3");
      assert.equal((await troveManager.Troves(carol))[3], "3");
    });

    it("Stability Pool profit matches", async () => {
      const { A_totalDebt, C_coll, price } = await setup();

      const spEthBefore = await stabilityPool.getETH();
      const spZusdBefore = await stabilityPool.getTotalZUSDDeposits();

      await troveManager.batchLiquidateTroves([alice, carol]);

      assert.isFalse(await sortedTroves.contains(alice));
      assert.isFalse(await sortedTroves.contains(carol));
      assert.equal((await troveManager.Troves(alice))[3], "3");
      assert.equal((await troveManager.Troves(carol))[3], "3");

      const spEthAfter = await stabilityPool.getETH();
      const spZusdAfter = await stabilityPool.getTotalZUSDDeposits();

      // liquidated collateral with the gas compensation subtracted
      const expectedCollateralLiquidatedA = th.applyLiquidationFee(A_totalDebt.mul(mv._MCR).div(price));
      const expectedGainInZUSD = expectedCollateralLiquidatedA.mul(price).div(mv._1e18BN).sub(A_totalDebt);
      const realGainInZUSD = spEthAfter.sub(spEthBefore).mul(price).div(mv._1e18BN).sub(spZusdBefore.sub(spZusdAfter));

      assert.equal(spEthAfter.sub(spEthBefore).toString(), expectedCollateralLiquidatedA.toString(), "Stability Pool RBTC doesn't match");
      assert.equal(spZusdBefore.sub(spZusdAfter).toString(), A_totalDebt.toString(), "Stability Pool ZUSD doesn't match");
      assert.equal(realGainInZUSD.toString(), expectedGainInZUSD.toString(), "Stability Pool gains don't match");
    });

    it("A trove over TCR is not liquidated", async () => {
      const { totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(280, 16)), extraParams: { from: alice } });
      const { totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(276, 16)), extraParams: { from: bob } });
      const { totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(150, 16)), extraParams: { from: carol } });

      const totalLiquidatedDebt = A_totalDebt.add(B_totalDebt).add(C_totalDebt);

      await openTrove({ ICR: toBN(dec(310, 16)), extraZUSDAmount: totalLiquidatedDebt, extraParams: { from: whale } });
      await stabilityPool.provideToSP(totalLiquidatedDebt, ZERO_ADDRESS, { from: whale });

      // Price drops
      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();
      const TCR = await th.getTCR(contracts);

      assert.isTrue(await th.checkRecoveryMode(contracts));

      // A above TCR, B in 110% < ICR < TCR, C below 100%
      const ICR_A = await troveManager.getCurrentICR(alice, price);
      const ICR_B = await troveManager.getCurrentICR(bob, price);
      const ICR_C = await troveManager.getCurrentICR(carol, price);

      assert.isTrue(ICR_A.gt(TCR));
      assert.isTrue(ICR_B.gt(mv._MCR) && ICR_B.lt(TCR));
      assert.isTrue(ICR_C.lt(mv._ICR100));

      const tx = await troveManager.batchLiquidateTroves([bob, alice]);

      const liquidationEvents = th.getAllEventsByName(tx, "TroveLiquidated");
      assert.equal(liquidationEvents.length, 1, "Not enough liquidations");

      // Only Bob's trove removed
      assert.isTrue(await sortedTroves.contains(alice));
      assert.isFalse(await sortedTroves.contains(bob));
      assert.isTrue(await sortedTroves.contains(carol));

      assert.equal((await troveManager.Troves(bob))[3], "3");
      assert.equal((await troveManager.Troves(alice))[3], "1");
      assert.equal((await troveManager.Troves(carol))[3], "1");
    });
  });

  context("Sequential liquidations", () => {
    const setup = async () => {
      const { collateral: A_coll, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(299, 16)), extraParams: { from: alice } });
      const { collateral: B_coll, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(298, 16)), extraParams: { from: bob } });

      const totalLiquidatedDebt = A_totalDebt.add(B_totalDebt);
      const spDeposit = totalLiquidatedDebt.add(toBN(dec(1, 18)));

      await openTrove({ ICR: toBN(dec(300, 16)), extraZUSDAmount: spDeposit, extraParams: { from: whale } });
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale });

      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice();
      const TCR = await th.getTCR(contracts);

      assert.isTrue(await th.checkRecoveryMode(contracts));

      const ICR_A = await troveManager.getCurrentICR(alice, price);
      const ICR_B = await troveManager.getCurrentICR(bob, price);

      assert.isTrue(ICR_A.gt(mv._MCR) && ICR_A.lt(TCR));
      assert.isTrue(ICR_B.gt(mv._MCR) && ICR_B.lt(TCR));

      return { A_coll, A_totalDebt, B_coll, B_totalDebt, totalLiquidatedDebt, price };
    };

    it("First trove only doesn't get out of Recovery Mode", async () => {
      await setup();
      await troveManager.liquidateTroves(1);
      assert.isTrue(await th.checkRecoveryMode(contracts));
    });

    it("Two troves over MCR are liquidated", async () => {
      await setup();
      const tx = await troveManager.liquidateTroves(10);

      const liquidationEvents = th.getAllEventsByName(tx, "TroveLiquidated");
      assert.equal(liquidationEvents.length, 2, "Not enough liquidations");

      assert.isFalse(await sortedTroves.contains(alice));
      assert.isFalse(await sortedTroves.contains(bob));
      assert.equal((await troveManager.Troves(alice))[3], "3");
      assert.equal((await troveManager.Troves(bob))[3], "3");
    });
  });
});
