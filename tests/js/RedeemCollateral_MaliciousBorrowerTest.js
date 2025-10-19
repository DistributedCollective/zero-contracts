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
const timeValues = testHelpers.TimeValues;

contract("TroveManager - Malicious Borrower Redemption", async accounts => {
  const [owner, whale, alice] = accounts;
  const multisig = owner;

  let contracts;
  let priceFeed;
  let troveManager;
  let borrowerOperations;
  let sortedTroves;
  let collSurplusPool;
  let zusdToken;

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

    return { minNetDebt, totalDebt };
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
    zusdToken = contracts.zusdToken;
  });

  beforeEach(async () => {
    const snapshot = await timeMachine.takeSnapshot();
    revertToSnapshot = () => timeMachine.revertToSnapshot(snapshot.result);
  });

  afterEach(async () => {
    await revertToSnapshot();
  });

  it("redemption closes a malicious trove and still credits surplus to the protocol", async () => {
    await openTrove({
      ICR: toBN(dec(3, 18)),
      extraZUSDAmount: toBN(dec(6000, 18)),
      extraParams: { from: whale }
    });

    const malicious = await NonPayable.new();
    await openTroveThroughForward(malicious, toBN(dec(2, 18)));
    const maliciousDebt = await troveManager.getTroveDebt(malicious.address);
    const gasComp = await troveManager.ZUSD_GAS_COMPENSATION();
    const redeemAmount = maliciousDebt.sub(gasComp);

    await openTrove({
      ICR: toBN(dec(3, 18)),
      extraParams: { from: alice }
    });
    await zusdToken.transfer(alice, redeemAmount, { from: whale });

    await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);

    const aliceBalanceBefore = toBN(await web3.eth.getBalance(alice));
    const aliceZusdBalance = await zusdToken.balanceOf(alice);

    assert.isTrue(
      aliceZusdBalance.gte(redeemAmount),
      "redeemer must hold enough ZUSD to cover the targeted debt"
    );

    const redemptionTx = await th.redeemCollateralAndGetTxObject(
      alice,
      contracts,
      redeemAmount
    );
    assert.isTrue(redemptionTx.receipt.status, "redemption transaction should succeed");

    const troveRecord = await troveManager.Troves(malicious.address);
    assert.equal(troveRecord[3].toString(), "4", "trove should be closed by redemption");
    assert.isFalse(
      await sortedTroves.contains(malicious.address),
      "redeemed trove should be removed from the sorted list"
    );

    const surplus = await collSurplusPool.getCollateral(malicious.address);
    assert.isTrue(surplus.gt(toBN(0)), "surplus collateral should be tracked for the borrower");

    const aliceBalanceAfter = toBN(await web3.eth.getBalance(alice));
    assert.isTrue(
      aliceBalanceAfter.gt(aliceBalanceBefore),
      "redeemer should receive collateral in native coin"
    );

    const claimData = th.getTransactionData("claimCollateral()", []);
    await th.assertRevert(
      malicious.forward(borrowerOperations.address, claimData),
      "CollSurplusPool: sending ETH failed"
    );
  });
});
