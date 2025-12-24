const BN = require("bn.js");
const Destructible = artifacts.require("./TestContracts/Destructible.sol");
const { signERC2612Permit } = require('eth-permit');
const hre = require("hardhat");

const MoneyValues = {
  negative_5e17: "-" + web3.utils.toWei("500", "finney"),
  negative_1e18: "-" + web3.utils.toWei("1", "ether"),
  negative_10e18: "-" + web3.utils.toWei("10", "ether"),
  negative_50e18: "-" + web3.utils.toWei("50", "ether"),
  negative_100e18: "-" + web3.utils.toWei("100", "ether"),
  negative_101e18: "-" + web3.utils.toWei("101", "ether"),
  negative_eth: amount => "-" + web3.utils.toWei(amount, "ether"),

  _zeroBN: web3.utils.toBN("0"),
  _1e18BN: web3.utils.toBN("1000000000000000000"),
  _10e18BN: web3.utils.toBN("10000000000000000000"),
  _100e18BN: web3.utils.toBN("100000000000000000000"),
  _100BN: web3.utils.toBN("100"),
  _110BN: web3.utils.toBN("110"),
  _150BN: web3.utils.toBN("150"),

  _MCR: web3.utils.toBN("1100000000000000000"),
  _ICR100: web3.utils.toBN("1000000000000000000"),
  _CCR: web3.utils.toBN("1500000000000000000")
};

const TimeValues = {
  SECONDS_IN_ONE_MINUTE: 60,
  SECONDS_IN_ONE_HOUR: 60 * 60,
  SECONDS_IN_ONE_DAY: 60 * 60 * 24,
  SECONDS_IN_ONE_WEEK: 60 * 60 * 24 * 7,
  SECONDS_IN_SIX_WEEKS: 60 * 60 * 24 * 7 * 6,
  SECONDS_IN_ONE_MONTH: 60 * 60 * 24 * 30,
  SECONDS_IN_ONE_YEAR: 60 * 60 * 24 * 365,
  MINUTES_IN_ONE_WEEK: 60 * 24 * 30,
  MINUTES_IN_ONE_MONTH: 60 * 24 * 30,
  MINUTES_IN_ONE_YEAR: 60 * 24 * 365
};

class TestHelper {
  static dec(val, scale) {
    let zerosCount;

    if (scale == "ether") {
      zerosCount = 18;
    } else if (scale == "finney") zerosCount = 15;
    else {
      zerosCount = scale;
    }

    const strVal = val.toString();
    const strZeros = "0".repeat(zerosCount);

    return strVal.concat(strZeros);
  }

  static squeezeAddr(address) {
    const len = address.length;
    return address
      .slice(0, 6)
      .concat("...")
      .concat(address.slice(len - 4, len));
  }

  static getDifference(x, y) {
    const x_BN = web3.utils.toBN(x);
    const y_BN = web3.utils.toBN(y);

    return Number(x_BN.sub(y_BN).abs());
  }

  static assertIsApproximatelyEqual(x, y, error = 1000) {
    assert.isAtMost(this.getDifference(x, y), error);
  }

  static zipToObject(array1, array2) {
    let obj = {};
    array1.forEach((element, idx) => (obj[element] = array2[idx]));
    return obj;
  }

  static getGasMetrics(gasCostList) {
    const minGas = Math.min(...gasCostList);
    const maxGas = Math.max(...gasCostList);

    let sum = 0;
    for (const gas of gasCostList) {
      sum += gas;
    }

    if (sum === 0) {
      return {
        gasCostList: gasCostList,
        minGas: undefined,
        maxGas: undefined,
        meanGas: undefined,
        medianGas: undefined
      };
    }
    const meanGas = sum / gasCostList.length;

    // median is the middle element (for odd list size) or element adjacent-right of middle (for even list size)
    const sortedGasCostList = [...gasCostList].sort();
    const medianGas = sortedGasCostList[Math.floor(sortedGasCostList.length / 2)];
    return { gasCostList, minGas, maxGas, meanGas, medianGas };
  }

  static getGasMinMaxAvg(gasCostList) {
    const metrics = th.getGasMetrics(gasCostList);

    const minGas = metrics.minGas;
    const maxGas = metrics.maxGas;
    const meanGas = metrics.meanGas;
    const medianGas = metrics.medianGas;

    return { minGas, maxGas, meanGas, medianGas };
  }

  static getEndOfAccount(account) {
    const accountLast2bytes = account.slice(account.length - 4, account.length);
    return accountLast2bytes;
  }

  static randDecayFactor(min, max) {
    const amount = Math.random() * (max - min) + min;
    const amountInWei = web3.utils.toWei(amount.toFixed(18), "ether");
    return amountInWei;
  }

  static randAmountInWei(min, max) {
    const amount = Math.random() * (max - min) + min;
    const amountInWei = web3.utils.toWei(amount.toString(), "ether");
    return amountInWei;
  }

  static randAmountInGWei(min, max) {
    const amount = Math.floor(Math.random() * (max - min) + min);
    const amountInWei = web3.utils.toWei(amount.toString(), "gwei");
    return amountInWei;
  }

  static makeWei(num) {
    return web3.utils.toWei(num.toString(), "ether");
  }

  static appendData(results, message, data) {
    data.push(message + `\n`);
    for (const key in results) {
      data.push(key + "," + results[key] + "\n");
    }
  }

  static getRandICR(min, max) {
    const ICR_Percent = Math.floor(Math.random() * (max - min) + min);

    // Convert ICR to a duint
    const ICR = web3.utils.toWei((ICR_Percent * 10).toString(), "finney");
    return ICR;
  }

  static computeICR(coll, debt, price) {
    const collBN = web3.utils.toBN(coll);
    const debtBN = web3.utils.toBN(debt);
    const priceBN = web3.utils.toBN(price);

    const ICR = debtBN.eq(this.toBN("0"))
      ? this.toBN("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
      : collBN.mul(priceBN).div(debtBN);

    return ICR;
  }

  static async ICRbetween100and110(account, troveManager, price) {
    const ICR = await troveManager.getCurrentICR(account, price);
    return ICR.gt(MoneyValues._ICR100) && ICR.lt(MoneyValues._MCR);
  }

  static async isUndercollateralized(account, troveManager, price) {
    const ICR = await troveManager.getCurrentICR(account, price);
    return ICR.lt(MoneyValues._MCR);
  }

  static toBN(num) {
    return web3.utils.toBN(num);
  }

  static gasUsed(tx) {
    const gas = tx.receipt.gasUsed;
    return gas;
  }

  static applyLiquidationFee(ethAmount) {
    return ethAmount.mul(this.toBN(this.dec(995, 15))).div(MoneyValues._1e18BN);
  }
  // --- Logging functions ---

  static logGasMetrics(gasResults, message) {
    console.log(
      `\n ${message} \n
      min gas: ${gasResults.minGas} \n
      max gas: ${gasResults.maxGas} \n
      mean gas: ${gasResults.meanGas} \n
      median gas: ${gasResults.medianGas} \n`
    );
  }

  static logAllGasCosts(gasResults) {
    console.log(`all gas costs: ${gasResults.gasCostList} \n`);
  }

  static logGas(gas, message) {
    console.log(
      `\n ${message} \n
      gas used: ${gas} \n`
    );
  }

  static async logActiveAccounts(contracts, n) {
    const count = await contracts.sortedTroves.getSize();
    const price = await contracts.priceFeedTestnet.getPrice();

    n = typeof n == "undefined" ? count : n;

    let account = await contracts.sortedTroves.getLast();
    const head = await contracts.sortedTroves.getFirst();

    console.log(`Total active accounts: ${count}`);
    console.log(`First ${n} accounts, in ascending ICR order:`);

    let i = 0;
    while (i < n) {
      const squeezedAddr = this.squeezeAddr(account);
      const coll = (await contracts.troveManager.Troves(account))[1];
      const debt = (await contracts.troveManager.Troves(account))[0];
      const ICR = await contracts.troveManager.getCurrentICR(account, price);

      console.log(`Acct: ${squeezedAddr}  coll:${coll}  debt: ${debt}  ICR: ${ICR}`);

      if (account == head) {
        break;
      }

      account = await contracts.sortedTroves.getPrev(account);

      i++;
    }
  }

  static async logAccountsArray(accounts, troveManager, price, n) {
    const length = accounts.length;

    n = typeof n == "undefined" ? length : n;

    console.log(`Number of accounts in array: ${length}`);
    console.log(`First ${n} accounts of array:`);

    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];

      const squeezedAddr = this.squeezeAddr(account);
      const coll = (await troveManager.Troves(account))[1];
      const debt = (await troveManager.Troves(account))[0];
      const ICR = await troveManager.getCurrentICR(account, price);

      console.log(`Acct: ${squeezedAddr}  coll:${coll}  debt: ${debt}  ICR: ${ICR}`);
    }
  }

  static logBN(label, x) {
    x = x.toString().padStart(18, "0");
    // TODO: thousand separators
    const integerPart = x.slice(0, x.length - 18) ? x.slice(0, x.length - 18) : "0";
    console.log(`${label}:`, integerPart + "." + x.slice(-18));
  }

  // --- TCR and Recovery Mode functions ---

  // These functions use the PriceFeedTestNet view price function getPrice() which is sufficient for testing.
  // the mainnet contract PriceFeed uses fetchPrice, which is non-view and writes to storage.

  // To checkRecoveryMode / getTCR from the Zero mainnet contracts, pass a price value - this can be the lastGoodPrice
  // stored in Zero, or the current Chainlink ETHUSD price, etc.

  static async checkRecoveryMode(contracts) {
    const price = await contracts.priceFeedTestnet.getPrice();
    return contracts.troveManager.checkRecoveryMode(price);
  }

  static async getTCR(contracts) {
    const price = await contracts.priceFeedTestnet.getPrice();
    return contracts.troveManager.getTCR(price);
  }

  // --- Gas compensation calculation functions ---

  // Given a composite debt, returns the actual debt  - i.e. subtracts the virtual debt.
  // Virtual debt = 50 ZUSD.
  static async getActualDebtFromComposite(compositeDebt, contracts) {
    const issuedDebt = await contracts.troveManager.getActualDebtFromComposite(compositeDebt);
    return issuedDebt;
  }

  // Adds the gas compensation (50 ZUSD)
  static async getCompositeDebt(contracts, debt) {
    const compositeDebt = contracts.borrowerOperations.getCompositeDebt(debt);
    return compositeDebt;
  }

  static async getTroveEntireColl(contracts, trove) {
    // return this.toBN((await contracts.troveManager.getEntireDebtAndColl(trove))[1]);
    return (await contracts.troveManager.getEntireDebtAndColl(trove))[1];
  }

  static async getTroveEntireDebt(contracts, trove) {
    // return this.toBN((await contracts.troveManager.getEntireDebtAndColl(trove))[0]);
    return (await contracts.troveManager.getEntireDebtAndColl(trove))[0];
  }

  static async getTroveStake(contracts, trove) {
    return contracts.troveManager.getTroveStake(trove);
  }

  /*
   * given the requested ZUSD amomunt in openTrove, returns the total debt
   * So, it adds the gas compensation and the borrowing fee
   */
  static async getOpenTroveTotalDebt(contracts, zusdAmount) {
    const fee = await contracts.troveManager.getBorrowingFee(zusdAmount);
    const compositeDebt = await this.getCompositeDebt(contracts, zusdAmount);
    return compositeDebt.add(fee);
  }

  /*
   * given the desired total debt, returns the ZUSD amount that needs to be requested in openTrove
   * So, it subtracts the gas compensation and then the borrowing fee
   */
  static async getOpenTroveZUSDAmount(contracts, totalDebt) {
    const actualDebt = await this.getActualDebtFromComposite(totalDebt, contracts);
    return this.getNetBorrowingAmount(contracts, actualDebt);
  }

  // Subtracts the borrowing fee
  static async getNetBorrowingAmount(contracts, debtWithFee) {
    const borrowingRate = await contracts.troveManager.getBorrowingRateWithDecay();
    return this.toBN(debtWithFee)
      .mul(MoneyValues._1e18BN)
      .div(MoneyValues._1e18BN.add(borrowingRate));
  }

  // Adds the borrowing fee
  static async getAmountWithBorrowingFee(contracts, zusdAmount) {
    const fee = await contracts.troveManager.getBorrowingFee(zusdAmount);
    return zusdAmount.add(fee);
  }

  // Adds the redemption fee
  static async getRedemptionGrossAmount(contracts, expected) {
    const redemptionRate = await contracts.troveManager.getRedemptionRate();
    return expected.mul(MoneyValues._1e18BN).div(MoneyValues._1e18BN.add(redemptionRate));
  }

  // Get's total collateral minus total gas comp, for a series of troves.
  static async getExpectedTotalCollMinusTotalGasComp(troveList, contracts) {
    let totalCollRemainder = web3.utils.toBN("0");

    for (const trove of troveList) {
      const remainingColl = this.getCollMinusGasComp(trove, contracts);
      totalCollRemainder = totalCollRemainder.add(remainingColl);
    }
    return totalCollRemainder;
  }

  static getEmittedRedemptionValues(redemptionTx) {
    for (let i = 0; i < redemptionTx.logs.length; i++) {
      if (redemptionTx.logs[i].event === "Redemption") {
        const ZUSDAmount = redemptionTx.logs[i].args[0];
        const totalZUSDRedeemed = redemptionTx.logs[i].args[1];
        const totalETHDrawn = redemptionTx.logs[i].args[2];
        const ETHFee = redemptionTx.logs[i].args[3];

        return [ZUSDAmount, totalZUSDRedeemed, totalETHDrawn, ETHFee];
      }
    }
    throw "The transaction logs do not contain a redemption event";
  }

  static getEmittedLiquidationValues(liquidationTx) {
    for (let i = 0; i < liquidationTx.logs.length; i++) {
      if (liquidationTx.logs[i].event === "Liquidation") {
        const liquidatedDebt = liquidationTx.logs[i].args[0];
        const liquidatedColl = liquidationTx.logs[i].args[1];
        const collGasComp = liquidationTx.logs[i].args[2];
        const zusdGasComp = liquidationTx.logs[i].args[3];

        return [liquidatedDebt, liquidatedColl, collGasComp, zusdGasComp];
      }
    }
    throw "The transaction logs do not contain a liquidation event";
  }

  static getEmittedLiquidatedDebt(liquidationTx) {
    return this.getLiquidationEventArg(liquidationTx, 0); // LiquidatedDebt is position 0 in the Liquidation event
  }

  static getEmittedLiquidatedColl(liquidationTx) {
    return this.getLiquidationEventArg(liquidationTx, 1); // LiquidatedColl is position 1 in the Liquidation event
  }

  static getEmittedGasComp(liquidationTx) {
    return this.getLiquidationEventArg(liquidationTx, 2); // GasComp is position 2 in the Liquidation event
  }

  static getLiquidationEventArg(liquidationTx, arg) {
    for (let i = 0; i < liquidationTx.logs.length; i++) {
      if (liquidationTx.logs[i].event === "Liquidation") {
        return liquidationTx.logs[i].args[arg];
      }
    }

    throw "The transaction logs do not contain a liquidation event";
  }

  static getZUSDFeeFromZUSDBorrowingEvent(tx) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === "ZUSDBorrowingFeePaid") {
        return tx.logs[i].args[1].toString();
      }
    }
    throw "The transaction logs do not contain an ZUSDBorrowingFeePaid event";
  }

  static getEventArgByIndex(tx, eventName, argIndex) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === eventName) {
        return tx.logs[i].args[argIndex];
      }
    }
    throw `The transaction logs do not contain event ${eventName}`;
  }

  static getEventArgByName(tx, eventName, argName) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === eventName) {
        const keys = Object.keys(tx.logs[i].args);
        for (let j = 0; j < keys.length; j++) {
          if (keys[j] === argName) {
            return tx.logs[i].args[keys[j]];
          }
        }
      }
    }

    throw `The transaction logs do not contain event ${eventName} and arg ${argName}`;
  }

  static getAllEventsByName(tx, eventName) {
    const events = [];
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[i].event === eventName) {
        events.push(tx.logs[i]);
      }
    }
    return events;
  }

  static getDebtAndCollFromTroveUpdatedEvents(troveUpdatedEvents, address) {
    const event = troveUpdatedEvents.filter(event => event.args[0] === address)[0];
    return [event.args[1], event.args[2]];
  }

  static async getBorrowerOpsListHint(contracts, newColl, newDebt) {
    const newNICR = await contracts.hintHelpers.computeNominalCR(newColl, newDebt);
    const {
      hintAddress: approxfullListHint,
      latestRandomSeed
    } = await contracts.hintHelpers.getApproxHint(newNICR, 5, this.latestRandomSeed);
    this.latestRandomSeed = latestRandomSeed;

    const { 0: upperHint, 1: lowerHint } = await contracts.sortedTroves.findInsertPosition(
      newNICR,
      approxfullListHint,
      approxfullListHint
    );
    return { upperHint, lowerHint };
  }

  static async getEntireCollAndDebt(contracts, account) {
    // console.log(`account: ${account}`)
    const rawColl = (await contracts.troveManager.Troves(account))[1];
    const rawDebt = (await contracts.troveManager.Troves(account))[0];
    const pendingETHReward = await contracts.troveManager.getPendingETHReward(account);
    const pendingZUSDDebtReward = await contracts.troveManager.getPendingZUSDDebtReward(account);
    const entireColl = rawColl.add(pendingETHReward);
    const entireDebt = rawDebt.add(pendingZUSDDebtReward);

    return { entireColl, entireDebt };
  }

  static async getCollAndDebtFromAddColl(contracts, account, amount) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account);

    const newColl = entireColl.add(this.toBN(amount));
    const newDebt = entireDebt;
    return { newColl, newDebt };
  }

  static async getCollAndDebtFromWithdrawColl(contracts, account, amount) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account);
    // console.log(`entireColl  ${entireColl}`)
    // console.log(`entireDebt  ${entireDebt}`)

    const newColl = entireColl.sub(this.toBN(amount));
    const newDebt = entireDebt;
    return { newColl, newDebt };
  }

  static async getCollAndDebtFromWithdrawZUSD(contracts, account, amount) {
    const fee = await contracts.troveManager.getBorrowingFee(amount);
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account);

    const newColl = entireColl;
    const newDebt = entireDebt.add(this.toBN(amount)).add(fee);

    return { newColl, newDebt };
  }

  static async getCollAndDebtFromRepayZUSD(contracts, account, amount) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account);

    const newColl = entireColl;
    const newDebt = entireDebt.sub(this.toBN(amount));

    return { newColl, newDebt };
  }

  static async getCollAndDebtFromAdjustment(contracts, account, ETHChange, ZUSDChange) {
    const { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account);

    // const coll = (await contracts.troveManager.Troves(account))[1]
    // const debt = (await contracts.troveManager.Troves(account))[0]

    const fee = ZUSDChange.gt(this.toBN("0"))
      ? await contracts.troveManager.getBorrowingFee(ZUSDChange)
      : this.toBN("0");
    const newColl = entireColl.add(ETHChange);
    const newDebt = entireDebt.add(ZUSDChange).add(fee);

    return { newColl, newDebt };
  }


  static _getBorrowerOpsTruffleInstance(contracts) {
    const bo = contracts.borrowerOperations;

    // If it's the Proxy wrapper, it has forwardFunction() and a .contract pointing to the real Truffle instance
    if (bo && typeof bo.forwardFunction === "function" && bo.contract) {
      return bo.contract;
    }

    // Otherwise it's already the Truffle contract instance
    return bo;
  }

  static _getBorrowerOpsCallFrom(contracts, from) {
    const bo = contracts.borrowerOperations;

    // In proxy tests, you may want msg.sender == DSProxy during eth_call
    if (bo && typeof bo.getProxyAddressFromUser === "function") {
      return bo.getProxyAddressFromUser(from);
    }

    return from;
  }

  static _getTroveManagerTruffleInstance(contracts) {
    const tm = contracts.troveManager;

    // Proxy wrapper has forwardFunction() and .contract points to the real Truffle instance
    if (tm && typeof tm.forwardFunction === "function" && tm.contract) {
      return tm.contract;
    }

    // Already the Truffle instance
    return tm;
  }


  static async getRedemptionBufferFeeRBTC(contracts, zusdAmount, from) {
    const bo = this._getBorrowerOpsTruffleInstance(contracts);
    if (!bo || !bo.getRedemptionBufferFeeRBTC) return this.toBN(0);

    const callFrom = from && from !== this.ZERO_ADDRESS ? this._getBorrowerOpsCallFrom(contracts, from) : undefined;
    const opts = callFrom ? { from: callFrom } : {};

    return this.toBN(await bo.getRedemptionBufferFeeRBTC.call(zusdAmount, opts));
  }

  static _getBorrowerAddress(contracts, user) {
    // If this is a proxy wrapper, map to DSProxy
    if (contracts.borrowerOperations && typeof contracts.borrowerOperations.getProxyAddressFromUser === "function") {
      return contracts.borrowerOperations.getProxyAddressFromUser(user);
    }
    return user;
  }




  // --- BorrowerOperations gas functions ---

  static async openTrove_allAccounts(accounts, contracts, ETHAmount, ZUSDAmount) {
    const gasCostList = [];
    const totalDebt = await this.getOpenTroveTotalDebt(contracts, ZUSDAmount);

    for (const account of accounts) {
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        ETHAmount,
        totalDebt
      );

      const tx = await contracts.borrowerOperations.openTrove(
        this._100pct,
        ZUSDAmount,
        upperHint,
        lowerHint,
        { from: account, value: ETHAmount }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async openTrove_allAccounts_randomETH(minETH, maxETH, accounts, contracts, ZUSDAmount) {
    const gasCostList = [];
    const totalDebt = await this.getOpenTroveTotalDebt(contracts, ZUSDAmount);

    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(minETH, maxETH);
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        randCollAmount,
        totalDebt
      );

      const tx = await contracts.borrowerOperations.openTrove(
        this._100pct,
        ZUSDAmount,
        upperHint,
        lowerHint,
        { from: account, value: randCollAmount }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async openTrove_allAccounts_randomETH_ProportionalZUSD(
    minETH,
    maxETH,
    accounts,
    contracts,
    proportion
  ) {
    const gasCostList = [];

    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(minETH, maxETH);
      const proportionalZUSD = web3.utils.toBN(proportion).mul(web3.utils.toBN(randCollAmount));
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, proportionalZUSD);

      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        randCollAmount,
        totalDebt
      );

      const tx = await contracts.borrowerOperations.openTrove(
        this._100pct,
        proportionalZUSD,
        upperHint,
        lowerHint,
        { from: account, value: randCollAmount }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async openTrove_allAccounts_randomETH_randomZUSD(
    minETH,
    maxETH,
    accounts,
    contracts,
    minZUSDProportion,
    maxZUSDProportion,
    logging = false
  ) {
    const gasCostList = [];
    const price = await contracts.priceFeedTestnet.getPrice();
    const _1e18 = web3.utils.toBN("1000000000000000000");

    let i = 0;
    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(minETH, maxETH);
      // console.log(`randCollAmount ${randCollAmount }`)
      const randZUSDProportion = this.randAmountInWei(minZUSDProportion, maxZUSDProportion);
      const proportionalZUSD = web3.utils
        .toBN(randZUSDProportion)
        .mul(web3.utils.toBN(randCollAmount).div(_1e18));
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, proportionalZUSD);
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        randCollAmount,
        totalDebt
      );

      const feeFloor = this.dec(5, 16);
      const tx = await contracts.borrowerOperations.openTrove(
        this._100pct,
        proportionalZUSD,
        upperHint,
        lowerHint,
        { from: account, value: randCollAmount }
      );

      if (logging && tx.receipt.status) {
        i++;
        const ICR = await contracts.troveManager.getCurrentICR(account, price);
        // console.log(`${i}. Trove opened. addr: ${this.squeezeAddr(account)} coll: ${randCollAmount} debt: ${proportionalZUSD} ICR: ${ICR}`)
      }
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async openTrove_allAccounts_randomZUSD(minZUSD, maxZUSD, accounts, contracts, ETHAmount) {
    const gasCostList = [];

    for (const account of accounts) {
      const randZUSDAmount = this.randAmountInWei(minZUSD, maxZUSD);
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, randZUSDAmount);
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        ETHAmount,
        totalDebt
      );

      const tx = await contracts.borrowerOperations.openTrove(
        this._100pct,
        randZUSDAmount,
        upperHint,
        lowerHint,
        { from: account, value: ETHAmount }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async closeTrove_allAccounts(accounts, contracts) {
    const gasCostList = [];

    for (const account of accounts) {
      const tx = await contracts.borrowerOperations.closeTrove({ from: account });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async openTrove_allAccounts_decreasingZUSDAmounts(
    accounts,
    contracts,
    ETHAmount,
    maxZUSDAmount
  ) {
    const gasCostList = [];

    let i = 0;
    for (const account of accounts) {
      const ZUSDAmount = (maxZUSDAmount - i).toString();
      const ZUSDAmountWei = web3.utils.toWei(ZUSDAmount, "ether");
      const totalDebt = await this.getOpenTroveTotalDebt(contracts, ZUSDAmountWei);
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        ETHAmount,
        totalDebt
      );

      const tx = await contracts.borrowerOperations.openTrove(
        this._100pct,
        ZUSDAmountWei,
        upperHint,
        lowerHint,
        { from: account, value: ETHAmount }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
      i += 1;
    }
    return this.getGasMetrics(gasCostList);
  }

  static async openTrove(
    contracts,
    { maxFeePercentage, zusdAmount, extraZUSDAmount, upperHint, lowerHint, ICR, extraParams }
  ) {
    // Can't specify both
    if (zusdAmount !== undefined && extraZUSDAmount !== undefined) {
      throw new Error("openTrove helper: specify either zusdAmount OR extraZUSDAmount, not both");
    }

    if (!maxFeePercentage) maxFeePercentage = this._100pct;

    if (!extraZUSDAmount) extraZUSDAmount = this.toBN(0);
    else if (typeof extraZUSDAmount == "string") extraZUSDAmount = this.toBN(extraZUSDAmount);

    if (!upperHint) upperHint = this.ZERO_ADDRESS;
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS;

    if (!extraParams) extraParams = {};
    if (!extraParams.from) throw new Error("openTrove helper: extraParams.from is required");

    const from = extraParams.from;

    const MIN_DEBT = (
      await this.getNetBorrowingAmount(contracts, await contracts.borrowerOperations.MIN_NET_DEBT())
    ).add(this.toBN(1)); // add 1 to avoid rounding issues

    // Decide requested ZUSD amount
    let requestedZUSDAmount;
    if (zusdAmount !== undefined) {
      requestedZUSDAmount = typeof zusdAmount === "string" ? this.toBN(zusdAmount) : this.toBN(zusdAmount);
    } else {
      if (!extraZUSDAmount) extraZUSDAmount = this.toBN(0);
      else if (typeof extraZUSDAmount === "string") extraZUSDAmount = this.toBN(extraZUSDAmount);

      requestedZUSDAmount = MIN_DEBT.add(extraZUSDAmount);
    }

    if (!ICR && !extraParams.value) ICR = this.toBN(this.dec(15, 17)); // 150%
    else if (typeof ICR == "string") ICR = this.toBN(ICR);

    const totalDebt = await this.getOpenTroveTotalDebt(contracts, requestedZUSDAmount);
    const netDebt = await this.getActualDebtFromComposite(totalDebt, contracts);

    // -----------------------------
    // NEW: compute intended trove collateral + buffer fee-on-top
    // -----------------------------

    // 1) intended collateral that should end up in the trove / ActivePool (NOT including buffer fee)
    let collateral;
    if (ICR) {
      const price = await contracts.priceFeedTestnet.getPrice();
      collateral = ICR.mul(totalDebt).div(price);
    } else {
      // If caller supplied a value without ICR, treat it as intended trove collateral
      // (previously msg.value == collateral; now we add fee on top)
      collateral =
        typeof extraParams.value == "string" ? this.toBN(extraParams.value) : this.toBN(extraParams.value);
    }

    // 2) quote the buffer fee for this borrow amount
    const bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, requestedZUSDAmount, from);

    // 3) send collateral + fee
    const totalValue = collateral.add(bufferFee);
    extraParams.value = totalValue;

    const tx = await contracts.borrowerOperations.openTrove(
      maxFeePercentage,
      requestedZUSDAmount,
      upperHint,
      lowerHint,
      extraParams
    );

    return {
      requestedZUSDAmount,
      netDebt,
      totalDebt,
      ICR,
      collateral,        // trove collateral (what ends up in ActivePool / Trove)
      bufferFee,         // fee paid to RedemptionBuffer
      totalValue,        // msg.value actually sent (collateral + fee)
      tx
    };
  }

  static async openNueTrove(
    contracts,
    { maxFeePercentage, extraZUSDAmount, upperHint, lowerHint, ICR, extraParams }
  ) {
    if (!maxFeePercentage) maxFeePercentage = this._100pct;

    if (!extraZUSDAmount) extraZUSDAmount = this.toBN(0);
    else if (typeof extraZUSDAmount == "string") extraZUSDAmount = this.toBN(extraZUSDAmount);

    if (!upperHint) upperHint = this.ZERO_ADDRESS;
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS;

    if (!extraParams) extraParams = {};
    if (!extraParams.from) throw new Error("openNueTrove helper: extraParams.from is required");
    const from = extraParams.from;

    const MIN_DEBT = (
      await this.getNetBorrowingAmount(contracts, await contracts.borrowerOperations.MIN_NET_DEBT())
    ).add(this.toBN(1)); // add 1 to avoid rounding issues

    const zusdAmount = MIN_DEBT.add(extraZUSDAmount);

    if (!ICR && !extraParams.value) ICR = this.toBN(this.dec(15, 17)); // 150%
    else if (typeof ICR == "string") ICR = this.toBN(ICR);

    const totalDebt = await this.getOpenTroveTotalDebt(contracts, zusdAmount);
    const netDebt = await this.getActualDebtFromComposite(totalDebt, contracts);

    // -----------------------------
    // NEW: compute intended trove collateral + buffer fee-on-top
    // -----------------------------

    // 1) intended collateral that should end up in the trove (NOT including buffer fee)
    let collateral;
    if (ICR) {
      const price = await contracts.priceFeedTestnet.getPrice();
      collateral = ICR.mul(totalDebt).div(price);
    } else {
      // If caller supplied a value without ICR, treat it as intended trove collateral
      collateral = this.toBN(extraParams.value);
    }

    // 2) quote the buffer fee for this borrow amount (non-view -> use .call())
    const bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, zusdAmount, from);

    // 3) send collateral + fee
    const totalValue = collateral.add(bufferFee);
    extraParams.value = totalValue;

    const tx = await contracts.borrowerOperations.openNueTrove(
      maxFeePercentage,
      zusdAmount,
      upperHint,
      lowerHint,
      extraParams
    );

    return {
      zusdAmount,
      netDebt,
      totalDebt,
      ICR,
      collateral,   // trove collateral (what ends up in ActivePool / Trove)
      bufferFee,    // fee paid to RedemptionBuffer
      totalValue,   // msg.value actually sent (collateral + fee)
      tx
    };
  }

  /**
   * adjustTrove(): wrapper around BorrowerOperations.adjustTrove that:
   * - optionally targets an ICR (for debt increase)
   * - automatically adds the RedemptionBuffer fee to msg.value when minting new ZUSD
   *
   * Notes:
   * - extraParams.value is treated as the *collateral top-up* (the amount that should end up in the trove),
   *   NOT including the buffer fee.
   * - If you are only increasing debt and not topping up collateral, omit extraParams.value and the helper
   *   will still send msg.value = bufferFee so the tx doesn't revert.
   */
  static async adjustTrove(
    contracts,
    { maxFeePercentage, collWithdrawal, zusdAmount, ICR, isDebtIncrease, upperHint, lowerHint, extraParams }
  ) {
    if (!extraParams) extraParams = {};
    if (maxFeePercentage === undefined || maxFeePercentage === null) maxFeePercentage = this._100pct;
    maxFeePercentage = this.toBN(maxFeePercentage);
    if (upperHint === undefined || upperHint === null) upperHint = this.ZERO_ADDRESS;
    if (lowerHint === undefined || lowerHint === null) lowerHint = this.ZERO_ADDRESS;
    if (collWithdrawal === undefined) collWithdrawal = this.toBN(0);
    else collWithdrawal = this.toBN(collWithdrawal);

    // default
    if (zusdAmount === undefined) zusdAmount = this.toBN(0);
    else zusdAmount = (typeof zusdAmount === "string") ? this.toBN(zusdAmount) : this.toBN(zusdAmount);

    // Default bool: infer from zusdAmount if not explicitly passed
    if (isDebtIncrease === undefined) isDebtIncrease = zusdAmount.gt(this.toBN(0));

    // Collateral topup intended for the trove (excluding buffer fee)
    let collTopUp = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

    // If targeting an ICR, compute the required ZUSD amount (debt increase only)
    let increasedTotalDebt = this.toBN(0);
    if (ICR) {
      assert(isDebtIncrease, "ICR targeting only makes sense for debt increases");
      assert(extraParams.from, "A 'from' account is needed");

      ICR = (typeof ICR === "string") ? this.toBN(ICR) : this.toBN(ICR);

      const borrower = this._getBorrowerAddress(contracts, extraParams.from);
      const { debt, coll } = await contracts.troveManager.getEntireDebtAndColl(borrower);

      const price = await contracts.priceFeedTestnet.getPrice();

      // newColl = existing coll + topup - withdrawal
      const newColl = coll.add(collTopUp).sub(collWithdrawal);

      const targetDebt = newColl.mul(price).div(ICR);
      assert(targetDebt.gt(debt), "ICR is already greater than or equal to target");

      increasedTotalDebt = targetDebt.sub(debt);
      zusdAmount = await this.getNetBorrowingAmount(contracts, increasedTotalDebt);
    }

    // If debt increase, compute (a) borrowing-fee-inclusive debt increase and (b) buffer fee in RBTC
    let bufferFee = this.toBN(0);

    if (isDebtIncrease) {
      // total debt increase that hits the trove struct includes borrowing fee
      if (increasedTotalDebt.eq(this.toBN(0))) {
        increasedTotalDebt = await this.getAmountWithBorrowingFee(contracts, zusdAmount);
      }

      // IMPORTANT: call options MUST NOT include `value` (getRedemptionBufferFeeRBTC is nonpayable)
      const fromForCall = extraParams.from ? extraParams.from : this.ZERO_ADDRESS;
      bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, zusdAmount, fromForCall);

      // msg.value must cover buffer fee + optional collateral top-up
      extraParams.value = collTopUp.add(bufferFee);
    } else {
      // no buffer fee needed
      extraParams.value = collTopUp;
    }

    const tx = await contracts.borrowerOperations.adjustTrove(
      maxFeePercentage,
      collWithdrawal,
      zusdAmount,
      isDebtIncrease,
      upperHint,
      lowerHint,
      extraParams
    );

    return {
      tx,
      zusdAmount,
      increasedTotalDebt,
      collTopUp,
      bufferFee
    };
  }

  // -------------------------------------------------------------------------
  // NUE / DLLR helpers
  // -------------------------------------------------------------------------

  static _emptyMassetPermitParams() {
    return {
      deadline: 0,
      v: 0,
      r: "0x" + "0".repeat(64),
      s: "0x" + "0".repeat(64)
    };
  }

  static _emptyPermit2PermitTransferFrom() {
    // ISignatureTransfer.PermitTransferFrom:
    // { permitted: { token, amount }, nonce, deadline }
    return {
      permitted: { token: this.ZERO_ADDRESS, amount: 0 },
      nonce: 0,
      deadline: 0
    };
  }

  static _normalizePermit2PermitTransferFrom(permit) {
    // Web3/Truffle is happiest with tuple-arrays. Support both object + tuple input.
    if (Array.isArray(permit)) return permit;

    const token = permit.permitted.token;
    const amount = permit.permitted.amount;
    const nonce = permit.nonce;
    const deadline = permit.deadline;

    return [[token, amount], nonce, deadline];
  }

  /**
   * adjustNueTrove(): wrapper around BorrowerOperations.adjustNueTrove.
   *
   * IMPORTANT SEMANTICS (based on your contract):
   * - if isDebtIncrease == true: `_ZUSDChange` is the ZUSD amount to mint (then converted to DLLR)
   * - if isDebtIncrease == false: `_ZUSDChange` is treated as a DLLR amount by the contract (repay via DLLR)
   *
   * This helper:
   * - adds RedemptionBuffer fee to msg.value for debt increases
   * - treats extraParams.value as collateral top-up *excluding* buffer fee
   */
  static async adjustNueTrove(
    contracts,
    {
      maxFeePercentage,
      collWithdrawal,
      zusdAmount,      // for debt increase
      dllrAmount,      // for repayment (isDebtIncrease=false)
      ICR,
      isDebtIncrease,
      upperHint,
      lowerHint,
      permitParams,
      extraParams
    }
  ) {
    if (!extraParams) extraParams = {};
    if (!maxFeePercentage) maxFeePercentage = this._100pct;
    if (!upperHint) upperHint = this.ZERO_ADDRESS;
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS;
    if (collWithdrawal === undefined) collWithdrawal = this.toBN(0);
    else collWithdrawal = this.toBN(collWithdrawal);

    // default permit params (unused in borrow path, required by ABI)
    if (!permitParams) permitParams = this._emptyMassetPermitParams();

    // Determine the "amount" argument passed to the contract
    let amount;
    if (isDebtIncrease === undefined) {
      // infer: if zusdAmount provided -> increase; else if dllrAmount provided -> repay
      isDebtIncrease = !!zusdAmount;
    }

    if (isDebtIncrease) {
      // debt increase uses zusdAmount
      if (zusdAmount === undefined) zusdAmount = this.toBN(0);
      zusdAmount = (typeof zusdAmount === "string") ? this.toBN(zusdAmount) : this.toBN(zusdAmount);

      // Collateral topup intended for trove (excluding buffer fee)
      let collTopUp = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

      // ICR targeting supported (borrow only)
      let increasedTotalDebt = this.toBN(0);
      if (ICR) {
        assert(extraParams.from, "A 'from' account is needed");
        ICR = (typeof ICR === "string") ? this.toBN(ICR) : this.toBN(ICR);

        const borrower = this._getBorrowerAddress(contracts, extraParams.from);
        const { debt, coll } = await contracts.troveManager.getEntireDebtAndColl(borrower);

        const price = await contracts.priceFeedTestnet.getPrice();
        const newColl = coll.add(collTopUp).sub(collWithdrawal);

        const targetDebt = newColl.mul(price).div(ICR);
        assert(targetDebt.gt(debt), "ICR is already greater than or equal to target");

        increasedTotalDebt = targetDebt.sub(debt);
        zusdAmount = await this.getNetBorrowingAmount(contracts, increasedTotalDebt);
      }

      // compute buffer fee based on minted ZUSD
      const fromForCall = extraParams.from ? extraParams.from : this.ZERO_ADDRESS;
      const bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, zusdAmount, fromForCall);


      extraParams.value = collTopUp.add(bufferFee);

      amount = zusdAmount;

      const tx = await contracts.borrowerOperations.adjustNueTrove(
        maxFeePercentage,
        collWithdrawal,
        amount,
        true,
        upperHint,
        lowerHint,
        permitParams,
        extraParams
      );

      return { tx, zusdAmount: amount, collTopUp, bufferFee };
    } else {
      // repayment path uses dllrAmount (contract treats `_ZUSDChange` as DLLR amount in this case)
      if (dllrAmount === undefined) {
        // allow reusing zusdAmount field as the "repay amount" if caller didn't supply dllrAmount
        dllrAmount = zusdAmount;
      }
      if (dllrAmount === undefined) dllrAmount = this.toBN(0);
      dllrAmount = (typeof dllrAmount === "string") ? this.toBN(dllrAmount) : this.toBN(dllrAmount);

      // no buffer fee
      extraParams.value = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

      amount = dllrAmount;

      const tx = await contracts.borrowerOperations.adjustNueTrove(
        maxFeePercentage,
        collWithdrawal,
        amount,
        false,
        upperHint,
        lowerHint,
        permitParams,
        extraParams
      );

      return { tx, dllrAmount: amount };
    }
  }

  /**
   * adjustNueTroveWithPermit2(): same logic as adjustNueTrove, but uses Permit2 parameters.
   * For debt increases, permit/signature are unused but still required by ABI.
   */
  static async adjustNueTroveWithPermit2(
    contracts,
    {
      maxFeePercentage,
      collWithdrawal,
      zusdAmount,
      dllrAmount,
      ICR,
      isDebtIncrease,
      upperHint,
      lowerHint,
      permit,
      signature,
      extraParams
    }
  ) {
    if (!extraParams) extraParams = {};
    if (!maxFeePercentage) maxFeePercentage = this._100pct;
    if (!upperHint) upperHint = this.ZERO_ADDRESS;
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS;
    if (collWithdrawal === undefined) collWithdrawal = this.toBN(0);
    else collWithdrawal = this.toBN(collWithdrawal);

    if (!permit) permit = this._emptyPermit2PermitTransferFrom();
    if (!signature) signature = "0x";

    const permitTuple = this._normalizePermit2PermitTransferFrom(permit);

    // Determine increase vs repay
    if (isDebtIncrease === undefined) isDebtIncrease = !!zusdAmount;

    if (isDebtIncrease) {
      if (zusdAmount === undefined) zusdAmount = this.toBN(0);
      zusdAmount = (typeof zusdAmount === "string") ? this.toBN(zusdAmount) : this.toBN(zusdAmount);

      let collTopUp = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

      // ICR targeting supported (borrow only)
      if (ICR) {
        assert(extraParams.from, "A 'from' account is needed");
        ICR = (typeof ICR === "string") ? this.toBN(ICR) : this.toBN(ICR);

        const borrower = this._getBorrowerAddress(contracts, extraParams.from);
        const { debt, coll } = await contracts.troveManager.getEntireDebtAndColl(borrower);

        const price = await contracts.priceFeedTestnet.getPrice();
        const newColl = coll.add(collTopUp).sub(collWithdrawal);

        const targetDebt = newColl.mul(price).div(ICR);
        assert(targetDebt.gt(debt), "ICR is already greater than or equal to target");

        const increasedTotalDebt = targetDebt.sub(debt);
        zusdAmount = await this.getNetBorrowingAmount(contracts, increasedTotalDebt);
      }

      const fromForCall = extraParams.from ? extraParams.from : this.ZERO_ADDRESS;
      const bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, zusdAmount, fromForCall);

      extraParams.value = collTopUp.add(bufferFee);

      const tx = await contracts.borrowerOperations.adjustNueTroveWithPermit2(
        maxFeePercentage,
        collWithdrawal,
        zusdAmount,
        true,
        upperHint,
        lowerHint,
        permitTuple,
        signature,
        extraParams
      );

      return { tx, zusdAmount, collTopUp, bufferFee };
    } else {
      if (dllrAmount === undefined) dllrAmount = zusdAmount;
      if (dllrAmount === undefined) dllrAmount = this.toBN(0);
      dllrAmount = (typeof dllrAmount === "string") ? this.toBN(dllrAmount) : this.toBN(dllrAmount);

      extraParams.value = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

      const tx = await contracts.borrowerOperations.adjustNueTroveWithPermit2(
        maxFeePercentage,
        collWithdrawal,
        dllrAmount,
        false,
        upperHint,
        lowerHint,
        permitTuple,
        signature,
        extraParams
      );

      return { tx, dllrAmount };
    }
  }

  // If you call withdrawZUSD with no extraParams.value, it will send msg.value = bufferFee automatically.
  // If you include extraParams.value, it becomes a collateral top-up, and the helper sends collTopUp + bufferFee.
  static async withdrawZUSD(
    contracts,
    { maxFeePercentage, zusdAmount, ICR, upperHint, lowerHint, extraParams }
  ) {
    if (!maxFeePercentage) maxFeePercentage = this._100pct;
    if (!upperHint) upperHint = this.ZERO_ADDRESS;
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS;
    if (!extraParams) extraParams = {};

    // --- normalize inputs to BN (dec(...) returns string) ---
    if (zusdAmount && typeof zusdAmount === "string") zusdAmount = this.toBN(zusdAmount);
    if (ICR && typeof ICR === "string") ICR = this.toBN(ICR);
    if (extraParams.value && typeof extraParams.value === "string") extraParams.value = this.toBN(extraParams.value);

    assert(
      !(zusdAmount && ICR) && (zusdAmount || ICR),
      "Specify either zusd amount or target ICR, but not both"
    );

    const collTopUp = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

    let increasedTotalDebt;
    if (ICR) {
      assert(extraParams.from, "A from account is needed");

      const borrower = this._getBorrowerAddress(contracts, extraParams.from);
      const { debt, coll } = await contracts.troveManager.getEntireDebtAndColl(borrower);

      const price = this.toBN(await contracts.priceFeedTestnet.getPrice());

      const debtBN = this.toBN(debt);
      const collBN = this.toBN(coll);

      const effectiveColl = collBN.add(collTopUp);
      const targetDebt = effectiveColl.mul(price).div(ICR);

      assert(targetDebt.gt(debtBN), "ICR is already greater than or equal to target");

      increasedTotalDebt = targetDebt.sub(debtBN);
      zusdAmount = await this.getNetBorrowingAmount(contracts, increasedTotalDebt);
    } else {
      // zusdAmount is BN here because we normalized it above
      increasedTotalDebt = await this.getAmountWithBorrowingFee(contracts, zusdAmount);
    }

    // Quote buffer fee and send it on top
    /*let bufferFee = this.toBN(0);
    if (contracts.borrowerOperations.getRedemptionBufferFeeRBTC) {
      const feeCallOpts = extraParams.from ? { from: extraParams.from } : {};
      bufferFee = this.toBN(
        await contracts.borrowerOperations.getRedemptionBufferFeeRBTC.call(zusdAmount, feeCallOpts)
      );
    }*/
    const bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, zusdAmount, extraParams.from);

    const totalValue = collTopUp.add(bufferFee);
    extraParams.value = totalValue;

    const tx = await contracts.borrowerOperations.withdrawZUSD(
      maxFeePercentage,
      zusdAmount,
      upperHint,
      lowerHint,
      extraParams
    );

    return { zusdAmount, increasedTotalDebt, collTopUp, bufferFee, totalValue, tx };
  }

  static async withdrawZusdAndConvertToDLLR(
    contracts,
    { maxFeePercentage, zusdAmount, ICR, upperHint, lowerHint, extraParams }
  ) {
    if (!maxFeePercentage) maxFeePercentage = this._100pct;
    if (!upperHint) upperHint = this.ZERO_ADDRESS;
    if (!lowerHint) lowerHint = this.ZERO_ADDRESS;
    if (!extraParams) extraParams = {};

    // --- normalize inputs to BN (dec(...) returns string) ---
    if (zusdAmount && typeof zusdAmount === "string") zusdAmount = this.toBN(zusdAmount);
    if (ICR && typeof ICR === "string") ICR = this.toBN(ICR);
    if (extraParams.value && typeof extraParams.value === "string") extraParams.value = this.toBN(extraParams.value);

    assert(
      !(zusdAmount && ICR) && (zusdAmount || ICR),
      "Specify either zusd amount or target ICR, but not both"
    );

    const collTopUp = extraParams.value ? this.toBN(extraParams.value) : this.toBN(0);

    let increasedTotalDebt;

    if (ICR) {
      assert(extraParams.from, "A 'from' account is needed");
      if (typeof ICR == "string") ICR = this.toBN(ICR);

      const borrower = this._getBorrowerAddress(contracts, extraParams.from);
      const { debt, coll } = await contracts.troveManager.getEntireDebtAndColl(borrower);

      const price = await contracts.priceFeedTestnet.getPrice();

      const effectiveColl = this.toBN(coll).add(collTopUp);
      const targetDebt = effectiveColl.mul(price).div(ICR);

      assert(targetDebt.gt(this.toBN(debt)), "ICR is already greater than or equal to target");

      increasedTotalDebt = targetDebt.sub(this.toBN(debt));
      zusdAmount = await this.getNetBorrowingAmount(contracts, increasedTotalDebt);
    } else {
      increasedTotalDebt = await this.getAmountWithBorrowingFee(contracts, zusdAmount);
    }

    // --- NEW: redemption buffer fee on ZUSD minting ---
    const bufferFee = await this.getRedemptionBufferFeeRBTC(contracts, zusdAmount, extraParams.from);


    const totalValue = collTopUp.add(bufferFee);

    // Use ethers for return value (DLLR amount)
    const { ethers } = hre;

    // Pick signer based on extraParams.from if provided
    const signers = await ethers.getSigners();
    let signer = signers[0];

    if (extraParams.from) {
      const want = extraParams.from.toLowerCase();
      for (const s of signers) {
        const addr = (s.address ? s.address : await s.getAddress()).toLowerCase();
        if (addr === want) {
          signer = s;
          break;
        }
      }
    }

    const ethersBorrowerOperations = await ethers.getContractAt(
      "BorrowerOperationsTester",
      contracts.borrowerOperations.address,
      signer
    );

    // Build ethers overrides: remove `from` (ethers signer already sets it)
    const overrides = { ...extraParams };
    delete overrides.from;
    overrides.value = totalValue.toString();

    // NOTE: ethers v6 uses `.staticCall(...)`
    const dllrAmount = await ethersBorrowerOperations.withdrawZusdAndConvertToDLLR.staticCall(
      maxFeePercentage.toString(),
      zusdAmount.toString(),
      upperHint,
      lowerHint,
      overrides
    );

    await ethersBorrowerOperations.withdrawZusdAndConvertToDLLR(
      maxFeePercentage.toString(),
      zusdAmount.toString(),
      upperHint,
      lowerHint,
      overrides
    );

    return {
      maxFeePercentage,
      upperHint,
      lowerHint,
      zusdAmount,
      increasedTotalDebt,
      collTopUp,
      bufferFee,
      totalValue,
      dllrAmount
    };
  }

  static async adjustTrove_allAccounts(accounts, contracts, ETHAmount, ZUSDAmount) {
    const gasCostList = [];

    for (const account of accounts) {
      let tx;

      let ETHChangeBN = this.toBN(ETHAmount);
      let ZUSDChangeBN = this.toBN(ZUSDAmount);

      const { newColl, newDebt } = await this.getCollAndDebtFromAdjustment(
        contracts,
        account,
        ETHChangeBN,
        ZUSDChangeBN
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const zero = this.toBN("0");

      let isDebtIncrease = ZUSDChangeBN.gt(zero);
      ZUSDChangeBN = ZUSDChangeBN.abs();

      // Add ETH to trove
      if (ETHChangeBN.gt(zero)) {
        tx = await contracts.borrowerOperations.adjustTrove(
          this._100pct,
          0,
          ZUSDChangeBN,
          isDebtIncrease,
          upperHint,
          lowerHint,
          { from: account, value: ETHChangeBN }
        );
        // Withdraw ETH from trove
      } else if (ETHChangeBN.lt(zero)) {
        ETHChangeBN = ETHChangeBN.neg();
        tx = await contracts.borrowerOperations.adjustTrove(
          this._100pct,
          ETHChangeBN,
          ZUSDChangeBN,
          isDebtIncrease,
          upperHint,
          lowerHint,
          { from: account }
        );
      }

      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async adjustTrove_allAccounts_randomAmount(
    accounts,
    contracts,
    ETHMin,
    ETHMax,
    ZUSDMin,
    ZUSDMax
  ) {
    const gasCostList = [];

    for (const account of accounts) {
      let tx;

      let ETHChangeBN = this.toBN(this.randAmountInWei(ETHMin, ETHMax));
      let ZUSDChangeBN = this.toBN(this.randAmountInWei(ZUSDMin, ZUSDMax));

      const { newColl, newDebt } = await this.getCollAndDebtFromAdjustment(
        contracts,
        account,
        ETHChangeBN,
        ZUSDChangeBN
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const zero = this.toBN("0");

      let isDebtIncrease = ZUSDChangeBN.gt(zero);
      ZUSDChangeBN = ZUSDChangeBN.abs();

      // Add ETH to trove
      if (ETHChangeBN.gt(zero)) {
        tx = await contracts.borrowerOperations.adjustTrove(
          this._100pct,
          0,
          ZUSDChangeBN,
          isDebtIncrease,
          upperHint,
          lowerHint,
          { from: account, value: ETHChangeBN }
        );
        // Withdraw ETH from trove
      } else if (ETHChangeBN.lt(zero)) {
        ETHChangeBN = ETHChangeBN.neg();
        tx = await contracts.borrowerOperations.adjustTrove(
          this._100pct,
          ETHChangeBN,
          ZUSDChangeBN,
          isDebtIncrease,
          lowerHint,
          upperHint,
          { from: account }
        );
      }

      const gas = this.gasUsed(tx);
      // console.log(`ETH change: ${ETHChangeBN},  ZUSDChange: ${ZUSDChangeBN}, gas: ${gas} `)

      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async addColl_allAccounts(accounts, contracts, amount) {
    const gasCostList = [];
    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromAddColl(contracts, account, amount);
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.addColl(upperHint, lowerHint, {
        from: account,
        value: amount
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async addColl_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];
    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(min, max);

      const { newColl, newDebt } = await this.getCollAndDebtFromAddColl(
        contracts,
        account,
        randCollAmount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.addColl(upperHint, lowerHint, {
        from: account,
        value: randCollAmount
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawColl_allAccounts(accounts, contracts, amount) {
    const gasCostList = [];
    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawColl(
        contracts,
        account,
        amount
      );
      // console.log(`newColl: ${newColl} `)
      // console.log(`newDebt: ${newDebt} `)
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.withdrawColl(amount, upperHint, lowerHint, {
        from: account
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawColl_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];

    for (const account of accounts) {
      const randCollAmount = this.randAmountInWei(min, max);

      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawColl(
        contracts,
        account,
        randCollAmount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.withdrawColl(
        randCollAmount,
        upperHint,
        lowerHint,
        { from: account }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
      // console.log("gasCostlist length is " + gasCostList.length)
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawZUSD_allAccounts(accounts, contracts, amount) {
    const gasCostList = [];

    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawZUSD(
        contracts,
        account,
        amount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.withdrawZUSD(
        this._100pct,
        amount,
        upperHint,
        lowerHint,
        { from: account }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawZUSD_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];

    for (const account of accounts) {
      const randZUSDAmount = this.randAmountInWei(min, max);

      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawZUSD(
        contracts,
        account,
        randZUSDAmount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.withdrawZUSD(
        this._100pct,
        randZUSDAmount,
        upperHint,
        lowerHint,
        { from: account }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async repayZUSD_allAccounts(accounts, contracts, amount) {
    const gasCostList = [];

    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromRepayZUSD(
        contracts,
        account,
        amount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.repayZUSD(amount, upperHint, lowerHint, {
        from: account
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async repayZUSD_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];

    for (const account of accounts) {
      const randZUSDAmount = this.randAmountInWei(min, max);

      const { newColl, newDebt } = await this.getCollAndDebtFromRepayZUSD(
        contracts,
        account,
        randZUSDAmount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.repayZUSD(randZUSDAmount, upperHint, lowerHint, {
        from: account
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  // ----------- withdrawZusdAndConvertToDLLR -------------- //

  static async withdrawZusdAndConvertToDLLR_allAccounts(accounts, contracts, amount) {
    const gasCostList = [];

    for (const account of accounts) {
      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawZUSD(
        contracts,
        account,
        amount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.withdrawZusdAndConvertToDLLR(
        this._100pct,
        amount,
        upperHint,
        lowerHint,
        { from: account }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawZusdAndConvertToDLLR_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];

    for (const account of accounts) {
      const randZUSDAmount = this.randAmountInWei(min, max);

      const { newColl, newDebt } = await this.getCollAndDebtFromWithdrawZUSD(
        contracts,
        account,
        randZUSDAmount
      );
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        newDebt
      );

      const tx = await contracts.borrowerOperations.withdrawZusdAndConvertToDLLR(
        this._100pct,
        randZUSDAmount,
        upperHint,
        lowerHint,
        { from: account }
      );
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  // ----------------- repayZusdFromDLLR ------------------ //


  static async repayZusdFromDLLRWithPermit2(account, contracts, amount, permitTransferFrom, signature) {
    const { newColl, newDebt } = await this.getCollAndDebtFromRepayZUSD(
      contracts,
      account,
      amount
    );
    const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
      contracts,
      newColl,
      newDebt
    );

    return await contracts.borrowerOperations.repayZusdFromDLLRWithPermit2(amount.toString(), upperHint, lowerHint, permitTransferFrom, signature, {
      from: account
    });
  }

  static async repayZusdFromDLLR(account, contracts, amount, permission) {
    const { newColl, newDebt } = await this.getCollAndDebtFromRepayZUSD(
      contracts,
      account,
      amount
    );
    const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
      contracts,
      newColl,
      newDebt
    );

    return await contracts.borrowerOperations.repayZusdFromDLLR(amount.toString(), upperHint, lowerHint, permission, {
      from: account
    });
  }

  static async repayZusdFromDLLR_allAccounts(accounts, contracts, amount) {
    const gasCostList = [];

    for (const account of accounts) {
      const permission = await signERC2612Permit(alice_signer, contracts.nueMockToken.address, alice_signer.address, borrowerOperations.address, decreaseAmount.toString());
      const tx = await this.repayZusdFromDLLR(account, contracts, amount);
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async repayZusdFromDLLR_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];

    for (const account of accounts) {
      const randZUSDAmount = this.randAmountInWei(min, max);
      const tx = await this.repayZusdFromDLLR(account, contracts, randZUSDAmount);
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }



  static async getCurrentICR_allAccounts(accounts, contracts, functionCaller) {
    const gasCostList = [];
    const price = await contracts.priceFeedTestnet.getPrice();

    for (const account of accounts) {
      const tx = await functionCaller.troveManager_getCurrentICR(account, price);
      const gas = this.gasUsed(tx) - 21000;
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  // --- Redemption functions ---

  static async redeemCollateral(redeemer, contracts, ZUSDAmount, maxFee = this._100pct) {
    const price = await contracts.priceFeedTestnet.getPrice();
    const tx = await this.performRedemptionTx(redeemer, price, contracts, ZUSDAmount, maxFee);
    const gas = await this.gasUsed(tx);
    return gas;
  }

  static async redeemCollateralAndGetTxObject(
    redeemer,
    contracts,
    ZUSDAmount,
    maxFee = this._100pct
  ) {
    const price = await contracts.priceFeedTestnet.getPrice();
    const tx = await this.performRedemptionTx(redeemer, price, contracts, ZUSDAmount, maxFee);
    return tx;
  }

  static async redeemCollateral_allAccounts_randomAmount(min, max, accounts, contracts) {
    const gasCostList = [];
    const price = await contracts.priceFeedTestnet.getPrice();

    for (const redeemer of accounts) {
      const randZUSDAmount = this.randAmountInWei(min, max);

      const tx = await this.performRedemptionTx(redeemer, price, contracts, randZUSDAmount);
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  /*static async performRedemptionTx(redeemer, price, contracts, ZUSDAmount, maxFee = 0) {
    const redemptionhint = await contracts.hintHelpers.getRedemptionHints(ZUSDAmount, price, 0);

    const firstRedemptionHint = redemptionhint[0];
    const partialRedemptionNewICR = redemptionhint[1];

    const {
      hintAddress: approxPartialRedemptionHint,
      latestRandomSeed
    } = await contracts.hintHelpers.getApproxHint(
      partialRedemptionNewICR,
      50,
      this.latestRandomSeed
    );
    this.latestRandomSeed = latestRandomSeed;

    const exactPartialRedemptionHint = await contracts.sortedTroves.findInsertPosition(
      partialRedemptionNewICR,
      approxPartialRedemptionHint,
      approxPartialRedemptionHint
    );

    // Ensure TroveManager can transferFrom redeemer for the buffer stage
    await contracts.zusdToken.approve(
      contracts.troveManager.address,
      ZUSDAmount,
      { from: redeemer }
    );


    const tx = await contracts.troveManager.redeemCollateral(
      ZUSDAmount,
      firstRedemptionHint,
      exactPartialRedemptionHint[0],
      exactPartialRedemptionHint[1],
      partialRedemptionNewICR,
      0,
      maxFee,
      { from: redeemer, gasPrice: 0 }
    );

    return tx;
  }*/

  static async performRedemptionTx(redeemer, price, contracts, ZUSDAmount, maxFee = 0) {
    const toBN = web3.utils.toBN;

    const amountBN = toBN(ZUSDAmount);
    const priceBN = toBN(price);

    // ------------------------------------------------------------------
    // Mirror TroveManagerRedeemOps._swapFromBuffer() to know "remainingZUSD"
    // ------------------------------------------------------------------
    let bufferBal = toBN("0");
    if (contracts.redemptionBuffer && contracts.redemptionBuffer.getBalance) {
      bufferBal = toBN(await contracts.redemptionBuffer.getBalance());
    } else if (contracts.redemptionBuffer && contracts.redemptionBuffer.address) {
      bufferBal = toBN(await web3.eth.getBalance(contracts.redemptionBuffer.address));
    }

    const DECIMAL_PRECISION = MoneyValues._1e18BN; // IMPORTANT: correct 1e18 BN

    const maxZusdFromBuffer = bufferBal.mul(priceBN).div(DECIMAL_PRECISION);
    const zusdFromBuffer = amountBN.lt(maxZusdFromBuffer) ? amountBN : maxZusdFromBuffer;
    const zusdFromTroves = amountBN.sub(zusdFromBuffer);

    // ------------------------------------------------------------------
    // Approve ONLY the buffer portion (transferFrom in _swapFromBuffer)
    // ------------------------------------------------------------------
    if (zusdFromBuffer.gt(toBN("0"))) {
      // Optional safety: reset allowance first for non-standard ERC20s
      await contracts.zusdToken.approve(contracts.troveManager.address, 0, { from: redeemer });

      await contracts.zusdToken.approve(
        contracts.troveManager.address,
        zusdFromBuffer,
        { from: redeemer }
      );
    }

    // ------------------------------------------------------------------
    // Redemption hints MUST be computed for the TROVE portion (remainingZUSD)
    // ------------------------------------------------------------------
    let firstRedemptionHint = this.ZERO_ADDRESS;
    let partialRedemptionNewICR = toBN("0");
    let upperHint = this.ZERO_ADDRESS;
    let lowerHint = this.ZERO_ADDRESS;

    if (zusdFromTroves.gt(toBN("0"))) {
      const redemptionhint = await contracts.hintHelpers.getRedemptionHints(
        zusdFromTroves,
        priceBN,
        0
      );

      firstRedemptionHint = redemptionhint[0];
      partialRedemptionNewICR = redemptionhint[1];

      const { hintAddress: approxPartialRedemptionHint, latestRandomSeed } =
        await contracts.hintHelpers.getApproxHint(
          partialRedemptionNewICR,
          50,
          this.latestRandomSeed
        );

      this.latestRandomSeed = latestRandomSeed;

      const exactPartialRedemptionHint = await contracts.sortedTroves.findInsertPosition(
        partialRedemptionNewICR,
        approxPartialRedemptionHint,
        approxPartialRedemptionHint
      );

      upperHint = exactPartialRedemptionHint[0];
      lowerHint = exactPartialRedemptionHint[1];
    }

    // IMPORTANT: still pass ORIGINAL amountBN to redeemCollateral()
    return contracts.troveManager.redeemCollateral(
      amountBN,
      firstRedemptionHint,
      upperHint,
      lowerHint,
      partialRedemptionNewICR,
      0,
      maxFee,
      { from: redeemer, gasPrice: 0 }
    );
  }




  // --- Composite functions ---

  static async makeTrovesIncreasingICR(accounts, contracts) {
    let amountFinney = 2000;

    for (const account of accounts) {
      const coll = web3.utils.toWei(amountFinney.toString(), "finney");

      await contracts.borrowerOperations.openTrove(
        this._100pct,
        "200000000000000000000",
        account,
        account,
        { from: account, value: coll }
      );

      amountFinney += 10;
    }
  }

  // --- StabilityPool gas functions ---

  static async provideToSP_allAccounts(accounts, stabilityPool, amount) {
    const gasCostList = [];
    for (const account of accounts) {
      const tx = await stabilityPool.provideToSP(amount, this.ZERO_ADDRESS, { from: account });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async provideToSP_allAccounts_randomAmount(min, max, accounts, stabilityPool) {
    const gasCostList = [];
    for (const account of accounts) {
      const randomZUSDAmount = this.randAmountInWei(min, max);
      const tx = await stabilityPool.provideToSP(randomZUSDAmount, this.ZERO_ADDRESS, {
        from: account
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawFromSP_allAccounts(accounts, stabilityPool, amount) {
    const gasCostList = [];
    for (const account of accounts) {
      const tx = await stabilityPool.withdrawFromSP(amount, { from: account });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawFromSP_allAccounts_randomAmount(min, max, accounts, stabilityPool) {
    const gasCostList = [];
    for (const account of accounts) {
      const randomZUSDAmount = this.randAmountInWei(min, max);
      const tx = await stabilityPool.withdrawFromSP(randomZUSDAmount, { from: account });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  static async withdrawETHGainToTrove_allAccounts(accounts, contracts) {
    const gasCostList = [];
    for (const account of accounts) {
      let { entireColl, entireDebt } = await this.getEntireCollAndDebt(contracts, account);
      console.log(`entireColl: ${entireColl}`);
      console.log(`entireDebt: ${entireDebt}`);
      const ETHGain = await contracts.stabilityPool.getDepositorETHGain(account);
      const newColl = entireColl.add(ETHGain);
      const { upperHint, lowerHint } = await this.getBorrowerOpsListHint(
        contracts,
        newColl,
        entireDebt
      );

      const tx = await contracts.stabilityPool.withdrawETHGainToTrove(upperHint, lowerHint, {
        from: account
      });
      const gas = this.gasUsed(tx);
      gasCostList.push(gas);
    }
    return this.getGasMetrics(gasCostList);
  }

  // --- ZERO & Lockup Contract functions ---

  static getLCAddressFromDeploymentTx(deployedLCTx) {
    return deployedLCTx.logs[0].args[0];
  }

  static async registerFrontEnds(frontEnds, stabilityPool) {
    for (const frontEnd of frontEnds) {
      await stabilityPool.registerFrontEnd(this.dec(5, 17), { from: frontEnd }); // default kickback rate of 50%
    }
  }

  // --- Time functions ---

  static async fastForwardTime(seconds, currentWeb3Provider) {
    await currentWeb3Provider.send(
      {
        id: 0,
        jsonrpc: "2.0",
        method: "evm_increaseTime",
        params: [seconds]
      },
      err => {
        if (err) console.log(err);
      }
    );

    await currentWeb3Provider.send(
      {
        id: 0,
        jsonrpc: "2.0",
        method: "evm_mine"
      },
      err => {
        if (err) console.log(err);
      }
    );
  }

  static async getLatestBlockTimestamp(web3Instance) {
    const blockNumber = await web3Instance.eth.getBlockNumber();
    const block = await web3Instance.eth.getBlock(blockNumber);

    return block.timestamp;
  }

  static async getTimestampFromTx(tx, web3Instance) {
    return this.getTimestampFromTxReceipt(tx.receipt, web3Instance);
  }

  static async getTimestampFromTxReceipt(txReceipt, web3Instance) {
    const block = await web3Instance.eth.getBlock(txReceipt.blockNumber);
    return block.timestamp;
  }

  static secondsToDays(seconds) {
    return Number(seconds) / (60 * 60 * 24);
  }

  static daysToSeconds(days) {
    return Number(days) * (60 * 60 * 24);
  }

  static async getTimeFromSystemDeployment(zeroToken, web3, timePassedSinceDeployment) {
    const deploymentTime = await zeroToken.getDeploymentStartTime();
    return this.toBN(deploymentTime).add(this.toBN(timePassedSinceDeployment));
  }

  // --- Assert functions ---

  static async assertRevert(txPromise, message = undefined) {
    try {
      const tx = await txPromise;
      // console.log("tx succeeded")
      assert.isFalse(tx.receipt.status); // when this assert fails, the expected revert didn't occur, i.e. the tx succeeded
    } catch (err) {
      assert.include(err.message, "revert");
      // TODO !!!

      // if (message) {
      //   assert.include(err.message, message)
      // }
    }
  }

  static async assertAssert(txPromise) {
    try {
      const tx = await txPromise;
      assert.isFalse(tx.receipt.status); // when this assert fails, the expected revert didn't occur, i.e. the tx succeeded
    } catch (err) {
      assert.include(err.message, "invalid opcode");
    }
  }

  // --- Misc. functions  ---

  static async forceSendEth(from, receiver, value) {
    const destructible = await Destructible.new();
    await web3.eth.sendTransaction({ to: destructible.address, from, value });
    await destructible.destruct(receiver);
  }

  static hexToParam(hexValue) {
    return ("0".repeat(64) + hexValue.slice(2)).slice(-64);
  }

  static formatParam(param) {
    let formattedParam = param;
    if (
      typeof param == "number" ||
      typeof param == "object" ||
      (typeof param == "string" && new RegExp("[0-9]*").test(param))
    ) {
      formattedParam = web3.utils.toHex(formattedParam);
    } else if (typeof param == "boolean") {
      formattedParam = param ? "0x01" : "0x00";
    } else if (param.slice(0, 2) != "0x") {
      formattedParam = web3.utils.asciiToHex(formattedParam);
    }

    return this.hexToParam(formattedParam);
  }
  static getTransactionData(signatureString, params) {
    /*
     console.log('signatureString: ', signatureString)
     console.log('params: ', params)
     console.log('params: ', params.map(p => typeof p))
     */
    return (
      web3.utils.sha3(signatureString).slice(0, 10) +
      params.reduce((acc, p) => acc + this.formatParam(p), "")
    );
  }

  static toDeadline(expiration) {
    return Math.floor((Date.now() + expiration) / 1000)
  }
  
  static extractSignature(signature) {
    const r = signature.slice(0, 66);
    const s = '0x' + signature.slice(66, 130);
    const v = '0x' + signature.slice(130, 132);
  
    return {v, r, s};
  }

  static generateNonce() {
    return BigInt(Math.floor(Date.now() + Math.random() * 100));
  }
  
  static bitmapPositions(nonce) {
    // Simulate logic to calculate wordPos and bitPos based on nonce
    const wordPos = Math.floor(nonce / 256);
    const bitPos = nonce % 256;
    return { wordPos, bitPos };
  }
  
  static async isUsedNonce(permit2, from, nonce) {
    const { wordPos, bitPos } = this.bitmapPositions(nonce);
    const bit = BigInt(1) << BigInt(bitPos);
  
    const nonceBitmapOnchain = BigInt((await permit2.nonceBitmap(from, wordPos)));
    const flipped = nonceBitmapOnchain ^ bit;
  
    if ((flipped & bit) === BigInt(0)) {
      return true;
    }
  
    return false;
  }
}

TestHelper.ZERO_ADDRESS = "0x" + "0".repeat(40);
TestHelper.maxBytes32 = "0x" + "f".repeat(64);
TestHelper._100pct = "1000000000000000000";
TestHelper.latestRandomSeed = 31337;
TestHelper.MAX_UINT_256 = web3.utils.toBN(2).pow(web3.utils.toBN(256)).sub(web3.utils.toBN(1));

module.exports = {
  TestHelper,
  MoneyValues,
  TimeValues
};
