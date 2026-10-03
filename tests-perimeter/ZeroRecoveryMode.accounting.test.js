const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");

const TroveManagerTester = artifacts.require("TroveManagerTester");
const ZUSDToken = artifacts.require("ZUSDToken");

const th = testHelpers.TestHelper;
const { toBN, dec } = th;

contract("Zero Recovery Mode — batch collateral accounting", async (accounts) => {
    const [owner, alice, bob, whale] = accounts;
    const multisig = accounts[999];
    let contracts;

    beforeEach(async () => {
        contracts = await deploymentHelper.deployLiquityCore();
        contracts.troveManager = await TroveManagerTester.new(contracts.permit2.address);
        contracts.zusdToken = await ZUSDToken.new();
        await contracts.zusdToken.initialize(
            contracts.troveManager.address,
            contracts.stabilityPool.address,
            contracts.borrowerOperations.address
        );
        const zeroContracts = await deploymentHelper.deployZEROContracts(multisig);
        await deploymentHelper.connectZEROContracts(zeroContracts);
        await deploymentHelper.connectCoreContracts(contracts, zeroContracts);
        await deploymentHelper.connectZEROContractsToCore(zeroContracts, contracts);
    });

    it("batch gas compensation cannot inflate TCR enough to liquidate a protected trove", async () => {
        const first = await th.openTrove(contracts, {
            ICR: toBN(dec(210, 16)),
            extraParams: { from: alice },
        });
        const candidate = await th.openTrove(contracts, {
            ICR: toBN(dec(2802, 15)),
            extraParams: { from: bob },
        });
        const deposit = first.totalDebt.add(candidate.totalDebt).add(toBN(dec(1, 18)));
        await th.openTrove(contracts, {
            ICR: toBN(dec(280, 16)),
            extraZUSDAmount: deposit,
            extraParams: { from: whale },
        });
        await contracts.stabilityPool.provideToSP(deposit, th.ZERO_ADDRESS, { from: whale });
        await contracts.priceFeedTestnet.setPrice(dec(100, 18));

        const price = await contracts.priceFeedTestnet.getPrice();
        assert.isTrue(await th.checkRecoveryMode(contracts));
        const firstICR = await contracts.troveManager.getCurrentICR(alice, price);
        assert.isTrue(firstICR.gt(toBN(dec(1, 18))));
        assert.isTrue(firstICR.lt(testHelpers.MoneyValues._MCR));

        const systemCollateral = (await contracts.activePool.getETH()).add(
            await contracts.defaultPool.getETH()
        );
        const systemDebt = (await contracts.activePool.getZUSDDebt()).add(
            await contracts.defaultPool.getZUSDDebt()
        );
        const remainingDebt = systemDebt.sub(first.totalDebt);
        const remainingCollateral = systemCollateral.sub(first.collateral);
        const gasCompensation = first.collateral.div(toBN(200));
        const correctTCR = remainingCollateral.mul(price).div(remainingDebt);
        const inflatedTCR = remainingCollateral.add(gasCompensation).mul(price).div(remainingDebt);
        const candidateICR = await contracts.troveManager.getCurrentICR(bob, price);
        assert.isTrue(candidateICR.gte(testHelpers.MoneyValues._MCR));
        assert.isTrue(inflatedTCR.lt(testHelpers.MoneyValues._CCR));
        assert.isTrue(candidateICR.gte(correctTCR), "candidate must be protected by actual TCR");
        assert.isTrue(candidateICR.lt(inflatedTCR), "candidate must expose the omitted deduction");

        const tx = await contracts.troveManager.batchLiquidateTroves([alice, bob], {
            from: owner,
        });
        assert.equal(th.getAllEventsByName(tx, "TroveLiquidated").length, 1);
        assert.isFalse(await contracts.sortedTroves.contains(alice));
        assert.isTrue(await contracts.sortedTroves.contains(bob));
        assert.equal((await contracts.troveManager.Troves(bob))[3].toString(), "1");
        assert.equal(
            (await contracts.activePool.getETH()).toString(),
            remainingCollateral.toString()
        );
        assert.equal((await th.getTCR(contracts)).toString(), correctTCR.toString());
    });
});
