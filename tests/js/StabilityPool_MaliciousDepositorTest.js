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

contract("StabilityPool - Malicious Depositor", async accounts => {
  const [owner, whale, alice, defaulter] = accounts;
  const multisig = owner;

  let contracts;
  let priceFeed;
  let troveManager;
  let borrowerOperations;
  let stabilityPool;
  let sortedTroves;
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

    return { minNetDebt };
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
    stabilityPool = contracts.stabilityPool;
    sortedTroves = contracts.sortedTroves;
    zusdToken = contracts.zusdToken;
  });

  beforeEach(async () => {
    const snapshot = await timeMachine.takeSnapshot();
    revertToSnapshot = () => timeMachine.revertToSnapshot(snapshot.result);
  });

  afterEach(async () => {
    await revertToSnapshot();
  });

  it("malicious depositor can only block their own withdrawals", async () => {
    await openTrove({
      ICR: toBN(dec(3, 18)),
      extraZUSDAmount: toBN(dec(6000, 18)),
      extraParams: { from: whale }
    });

    const malicious = await NonPayable.new();
    const { minNetDebt } = await openTroveThroughForward(malicious, toBN(dec(3, 18)));

    await openTrove({
      ICR: toBN(dec(3, 18)),
      extraParams: { from: alice }
    });

    await openTrove({
      ICR: toBN(dec(12, 17)),
      extraParams: { from: defaulter }
    });

    const depositData = th.getTransactionData("provideToSP(uint256,address)", [
      web3.utils.toHex(minNetDebt),
      th.ZERO_ADDRESS
    ]);
    await malicious.forward(stabilityPool.address, depositData);

    const aliceDeposit = toBN(dec(1000, 18));
    await zusdToken.transfer(alice, aliceDeposit, { from: whale });
    await stabilityPool.provideToSP(aliceDeposit, th.ZERO_ADDRESS, { from: alice });

    await priceFeed.setPrice(dec(150, 18));
    await troveManager.liquidate(defaulter, { from: owner });

    assert.isTrue(
      (await stabilityPool.getDepositorETHGain(malicious.address)).gt(toBN(0)),
      "malicious depositor should accrue an ETH gain"
    );

    await th.assertRevert(
      malicious.forward(
        stabilityPool.address,
        th.getTransactionData("withdrawFromSP(uint256)", [web3.utils.toHex(minNetDebt)])
      ),
      "StabilityPool: sending ETH failed"
    );

    const aliceBalanceBefore = toBN(await web3.eth.getBalance(alice));
    const aliceTx = await stabilityPool.withdrawFromSP(aliceDeposit, { from: alice, gasPrice: 0 });
    assert.isTrue(aliceTx.receipt.status, "honest depositor should be able to withdraw");

    const aliceBalanceAfter = toBN(await web3.eth.getBalance(alice));
    assert.isTrue(
      aliceBalanceAfter.gt(aliceBalanceBefore),
      "honest depositor should receive accumulated ETH"
    );

    const remainingDeposit = await stabilityPool.getCompoundedZUSDDeposit(malicious.address);
    assert.isTrue(
      remainingDeposit.gt(toBN(0)),
      "malicious depositor balance remains locked in the pool"
    );
  });
});
