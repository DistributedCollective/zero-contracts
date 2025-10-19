const deploymentHelper = require("../../utils/js/deploymentHelpers.js");
const testHelpers = require("../../utils/js/testHelpers.js");
const timeMachine = require("ganache-time-traveler");
const { assert } = require("chai");

const NonPayable = artifacts.require("NonPayable.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const ZUSDTokenTester = artifacts.require("ZUSDTokenTester");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;

contract("TroveManager - Malicious Borrower", async accounts => {
  const [owner, whale, alice] = accounts;
  const multisig = owner;

  let contracts;
  let priceFeed;
  let troveManager;
  let borrowerOperations;
  let sortedTroves;
  let collSurplusPool;
  let activePool;

  let revertToSnapshot;

  const openTrove = async params => th.openTrove(contracts, params);

  const openTroveThroughForward = async (forwarder, icr) => {
    const minNetDebt = (
      await th.getNetBorrowingAmount(contracts, await borrowerOperations.MIN_NET_DEBT())
    ).add(toBN(1));
    const totalDebt = await th.getOpenTroveTotalDebt(contracts, minNetDebt);
    const price = await priceFeed.getPrice();
    const collateral = totalDebt.mul(icr).div(price);

    const data = th.getTransactionData("openTrove(uint256,uint256,address,address)", [
      web3.utils.toHex(th._100pct),
      web3.utils.toHex(minNetDebt),
      th.ZERO_ADDRESS,
      th.ZERO_ADDRESS
    ]);

    await forwarder.forward(borrowerOperations.address, data, { value: collateral.toString() });

    return { minNetDebt, totalDebt, collateral };
  };

  before(async () => {
    contracts = await deploymentHelper.deployLiquityCore();
    const permit2 = contracts.permit2;
    contracts.troveManager = await TroveManagerTester.new(permit2.address);
    contracts.zusdToken = await ZUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address
    );
    const ZEROContracts = await deploymentHelper.deployZEROTesterContractsHardhat(multisig);

    await deploymentHelper.connectCoreContracts(contracts, ZEROContracts);
    await deploymentHelper.connectZEROContracts(ZEROContracts);
    await deploymentHelper.connectZEROContractsToCore(ZEROContracts, contracts);

    await ZEROContracts.zeroToken.unprotectedMint(multisig, toBN(dec(20, 24)));
    await ZEROContracts.zeroToken.unprotectedMint(owner, toBN(dec(30, 24)));
    await ZEROContracts.zeroToken.approve(
      ZEROContracts.communityIssuance.address,
      toBN(dec(30, 24))
    );
    await ZEROContracts.zeroToken.unprotectedMint(
      ZEROContracts.communityIssuance.address,
      toBN(dec(100, 24))
    );

    priceFeed = contracts.priceFeedTestnet;
    troveManager = contracts.troveManager;
    borrowerOperations = contracts.borrowerOperations;
    sortedTroves = contracts.sortedTroves;
    collSurplusPool = contracts.collSurplusPool;
    activePool = contracts.activePool;
  });

  beforeEach(async () => {
    const snapshot = await timeMachine.takeSnapshot();
    revertToSnapshot = () => timeMachine.revertToSnapshot(snapshot.result);
  });

  afterEach(async () => {
    await revertToSnapshot();
  });

  it("liquidation succeeds even if the borrower refuses native coin transfers", async () => {
    await openTrove({
      ICR: toBN(dec(2, 18)),
      extraParams: { from: whale }
    });

    const malicious = await NonPayable.new();

    await openTroveThroughForward(malicious, toBN(dec(15, 17)));

    assert.isTrue(await sortedTroves.contains(malicious.address), "trove should be active before price drop");

    await priceFeed.setPrice(dec(100, 18));

    const activePoolETHBefore = await activePool.getETH();

    const tx = await troveManager.liquidate(malicious.address, { from: owner });
    assert.isTrue(tx.receipt.status, "liquidation transaction should succeed");

    const troveRecord = await troveManager.Troves(malicious.address);
    assert.equal(troveRecord[3].toString(), "3", "trove should be marked closed by liquidation");

    const isStillInList = await sortedTroves.contains(malicious.address);
    assert.isFalse(isStillInList, "liquidated trove must be removed from the sorted list");

    const debtAfter = await troveManager.getTroveDebt(malicious.address);
    assert.equal(debtAfter.toString(), "0", "liquidated trove should have zero recorded debt");

    const activePoolETHAfter = await activePool.getETH();
    assert.isTrue(
      activePoolETHAfter.lt(activePoolETHBefore),
      "active pool balance should decline after liquidation"
    );

    await th.assertRevert(
      troveManager.liquidate(malicious.address, { from: owner }),
      "TroveManager: Trove does not exist or is closed"
    );
  });
});
