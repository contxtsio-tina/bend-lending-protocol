import BigNumber from "bignumber.js";
import { DRE, getNowTimeInSeconds, increaseTime, waitForTx } from "../helpers/misc-utils";
import { APPROVAL_AMOUNT_LENDING_POOL, oneEther, ONE_DAY, ONE_HOUR } from "../helpers/constants";
import { convertToCurrencyDecimals } from "../helpers/contracts-helpers";
import { makeSuite } from "./helpers/make-suite";
import { ProtocolErrors, ProtocolLoanState } from "../helpers/types";
import { getUserData } from "./helpers/utils/helpers";

const chai = require("chai");

const { expect } = chai;

makeSuite("LendPool: Redeem", (testEnv) => {
  before("Before Redeem: set config", () => {
    BigNumber.config({ DECIMAL_PLACES: 0, ROUNDING_MODE: BigNumber.ROUND_DOWN });
  });

  after("After Redeem: reset config", () => {
    BigNumber.config({ DECIMAL_PLACES: 20, ROUNDING_MODE: BigNumber.ROUND_HALF_UP });
  });

  it("WETH - Borrows WETH", async () => {
    const { users, pool, nftOracle, reserveOracle, weth, bayc, configurator, dataProvider } = testEnv;
    const depositor = users[0];
    const borrower = users[1];

    //mints WETH to depositor
    await weth.connect(depositor.signer).mint(await convertToCurrencyDecimals(weth.address, "1000"));

    //approve protocol to access depositor wallet
    await weth.connect(depositor.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    //deposits WETH
    const amountDeposit = await convertToCurrencyDecimals(weth.address, "1000");

    await pool.connect(depositor.signer).deposit(weth.address, amountDeposit, depositor.address, "0");

    //mints BAYC to borrower
    await bayc.connect(borrower.signer).mint("101");

    //approve protocol to access borrower wallet
    await bayc.connect(borrower.signer).setApprovalForAll(pool.address, true);

    //borrows
    const loanDataBefore = await pool.getNftLoanData(bayc.address, "101");

    const wethPrice = await reserveOracle.getAssetPrice(weth.address);

    const amountBorrow = await convertToCurrencyDecimals(
      weth.address,
      new BigNumber(loanDataBefore.availableBorrowsETH.toString())
        .div(wethPrice.toString())
        .multipliedBy(0.95)
        .toFixed(0)
    );

    await pool
      .connect(borrower.signer)
      .borrow(weth.address, amountBorrow.toString(), bayc.address, "101", borrower.address, "0");

    const loanDataAfter = await pool.getNftLoanData(bayc.address, "101");

    expect(loanDataAfter.healthFactor.toString()).to.be.bignumber.gt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("WETH - Drop the health factor below 1", async () => {
    const { weth, bayc, users, pool, nftOracle } = testEnv;
    const borrower = users[1];

    const baycPrice = await nftOracle.getAssetPrice(bayc.address);
    const latestTime = await getNowTimeInSeconds();
    await waitForTx(
      await nftOracle.setAssetData(
        bayc.address,
        new BigNumber(baycPrice.toString()).multipliedBy(0.55).toFixed(0),
        latestTime,
        latestTime
      )
    );

    const loanDataAfter = await pool.getNftLoanData(bayc.address, "101");

    expect(loanDataAfter.healthFactor.toString()).to.be.bignumber.lt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("WETH - Auctions the borrow", async () => {
    const { weth, bayc, bBAYC, users, pool, nftOracle, reserveOracle, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    //mints WETH to the liquidator
    await weth.connect(liquidator.signer).mint(await convertToCurrencyDecimals(weth.address, "1000"));

    //approve protocol to access the liquidator wallet
    await weth.connect(liquidator.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    const ethReserveDataBefore = await dataProvider.getReserveData(weth.address);

    const userReserveDataBefore = await getUserData(pool, dataProvider, weth.address, borrower.address);

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(bayc.address, "101");

    // accurate borrow index, increment interest to loanDataBefore.scaledAmount
    await increaseTime(100);

    const { liquidatePrice } = await pool.getNftLiquidatePrice(bayc.address, "101");

    await pool.connect(liquidator.signer).auction(bayc.address, "101", liquidatePrice, liquidator.address);

    // check result
    const loanDataAfter = await dataProvider.getLoanDataByLoanId(loanDataBefore.loanId);

    const userReserveDataAfter = await getUserData(pool, dataProvider, weth.address, borrower.address);

    const ethReserveDataAfter = await dataProvider.getReserveData(weth.address);

    expect(loanDataAfter.state).to.be.equal(ProtocolLoanState.Auction, "Invalid loan state after auction");

    const userVariableDebtAmountBeforeTx = new BigNumber(userReserveDataBefore.scaledVariableDebt).rayMul(
      new BigNumber(ethReserveDataAfter.variableBorrowIndex.toString())
    );

    // expect debt amount to be liquidated
    const expectedLiquidateAmount = new BigNumber(loanDataBefore.scaledAmount.toString()).rayMul(
      new BigNumber(ethReserveDataAfter.variableBorrowIndex.toString())
    );

    expect(userReserveDataAfter.currentVariableDebt.toString()).to.be.bignumber.almostEqual(
      userVariableDebtAmountBeforeTx.minus(expectedLiquidateAmount).toString(),
      "Invalid user debt after redeem"
    );

    //the liquidity index of the principal reserve needs to be bigger than the index before
    expect(ethReserveDataAfter.liquidityIndex.toString()).to.be.bignumber.gte(
      ethReserveDataBefore.liquidityIndex.toString(),
      "Invalid liquidity index"
    );

    //the principal APY after a liquidation needs to be lower than the APY before
    expect(ethReserveDataAfter.liquidityRate.toString()).to.be.bignumber.lt(
      ethReserveDataBefore.liquidityRate.toString(),
      "Invalid liquidity APY"
    );

    expect(ethReserveDataAfter.availableLiquidity.toString()).to.be.bignumber.almostEqual(
      new BigNumber(ethReserveDataBefore.availableLiquidity.toString()).plus(expectedLiquidateAmount).toFixed(0),
      "Invalid principal available liquidity"
    );

    const tokenOwner = await bayc.ownerOf("101");
    expect(tokenOwner).to.be.equal(bBAYC.address, "Invalid token owner after redeem");
  });

  it("WETH - Redeems the borrow", async () => {
    const { weth, bayc, users, pool, nftOracle, reserveOracle, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    //mints WETH to the borrower
    await weth.connect(borrower.signer).mint(await convertToCurrencyDecimals(weth.address, "1000"));
    //approve protocol to access the borrower wallet
    await weth.connect(borrower.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    const nftCfgData = await dataProvider.getNftConfigurationData(bayc.address);

    const auctionDataBefore = await pool.getNftAuctionData(bayc.address, "101");

    const liquidatorBalanceBefore = await weth.balanceOf(liquidator.address);

    // redeem duration
    await increaseTime(nftCfgData.redeemDuration.mul(ONE_DAY).sub(ONE_HOUR).toNumber());

    await pool.connect(borrower.signer).redeem(bayc.address, "101");

    // check result
    const tokenOwner = await bayc.ownerOf("101");
    expect(tokenOwner).to.be.equal(borrower.address, "Invalid token owner after redeem");

    const liquidatorBalanceAfter = await weth.balanceOf(liquidator.address);
    expect(liquidatorBalanceAfter).to.be.equal(
      liquidatorBalanceBefore.add(auctionDataBefore.bidPrice).add(auctionDataBefore.bidFine),
      "Invalid liquidator balance after redeem"
    );
  });

  it("USDC - Borrows USDC", async () => {
    const { users, pool, nftOracle, reserveOracle, usdc, bayc, configurator, dataProvider } = testEnv;
    const depositor = users[0];
    const borrower = users[1];

    //mints USDC to depositor
    await usdc.connect(depositor.signer).mint(await convertToCurrencyDecimals(usdc.address, "1000000"));

    //approve protocol to access depositor wallet
    await usdc.connect(depositor.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    //deposits USDC
    const amountDeposit = await convertToCurrencyDecimals(usdc.address, "1000000");

    await pool.connect(depositor.signer).deposit(usdc.address, amountDeposit, depositor.address, "0");

    //mints BAYC to borrower
    await bayc.connect(borrower.signer).mint("102");

    //uapprove protocol to access borrower wallet
    await bayc.connect(borrower.signer).setApprovalForAll(pool.address, true);

    //borrows
    const loanDataBefore = await pool.getNftLoanData(bayc.address, "102");

    const usdcPrice = await reserveOracle.getAssetPrice(usdc.address);

    const amountBorrow = await convertToCurrencyDecimals(
      usdc.address,
      new BigNumber(loanDataBefore.availableBorrowsETH.toString())
        .div(usdcPrice.toString())
        .multipliedBy(0.95)
        .toFixed(0)
    );

    await pool
      .connect(borrower.signer)
      .borrow(usdc.address, amountBorrow.toString(), bayc.address, "102", borrower.address, "0");

    const loanDataAfter = await pool.getNftLoanData(bayc.address, "102");

    expect(loanDataAfter.healthFactor.toString()).to.be.bignumber.gt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("USDC - Drop the health factor below 1", async () => {
    const { usdc, bayc, users, pool, nftOracle } = testEnv;
    const borrower = users[1];

    const baycPrice = await nftOracle.getAssetPrice(bayc.address);
    const latestTime = await getNowTimeInSeconds();
    await waitForTx(
      await nftOracle.setAssetData(
        bayc.address,
        new BigNumber(baycPrice.toString()).multipliedBy(0.55).toFixed(0),
        latestTime,
        latestTime
      )
    );

    const loanDataAfter = await pool.getNftLoanData(bayc.address, "102");

    expect(loanDataAfter.healthFactor.toString()).to.be.bignumber.lt(
      oneEther.toFixed(0),
      ProtocolErrors.VL_INVALID_HEALTH_FACTOR
    );
  });

  it("USDC - Auctions the borrow", async () => {
    const { usdc, bayc, bBAYC, users, pool, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    //mints USDC to the liquidator
    await usdc.connect(liquidator.signer).mint(await convertToCurrencyDecimals(usdc.address, "1000000"));

    //approve protocol to access the liquidator wallet
    await usdc.connect(liquidator.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    const usdcReserveDataBefore = await dataProvider.getReserveData(usdc.address);

    const userReserveDataBefore = await getUserData(pool, dataProvider, usdc.address, borrower.address);

    const loanDataBefore = await dataProvider.getLoanDataByCollateral(bayc.address, "102");

    // accurate borrow index, increment interest to loanDataBefore.scaledAmount
    await increaseTime(100);

    const { liquidatePrice } = await pool.getNftLiquidatePrice(bayc.address, "102");

    await pool.connect(liquidator.signer).auction(bayc.address, "102", liquidatePrice, liquidator.address);

    // check result
    const loanDataAfter = await dataProvider.getLoanDataByLoanId(loanDataBefore.loanId);

    const userReserveDataAfter = await getUserData(pool, dataProvider, usdc.address, borrower.address);

    const usdcReserveDataAfter = await dataProvider.getReserveData(usdc.address);

    const userVariableDebtAmountBeforeTx = new BigNumber(userReserveDataBefore.scaledVariableDebt).rayMul(
      new BigNumber(usdcReserveDataAfter.variableBorrowIndex.toString())
    );

    // expect debt amount to be liquidated
    const expectedLiquidateAmount = new BigNumber(loanDataBefore.scaledAmount.toString()).rayMul(
      new BigNumber(usdcReserveDataAfter.variableBorrowIndex.toString())
    );

    expect(loanDataAfter.state).to.be.equal(ProtocolLoanState.Auction, "Invalid loan state after redeem");

    expect(userReserveDataAfter.currentVariableDebt.toString()).to.be.bignumber.almostEqual(
      userVariableDebtAmountBeforeTx.minus(expectedLiquidateAmount).toString(),
      "Invalid user debt after redeem"
    );

    //the liquidity index of the principal reserve needs to be bigger than the index before
    expect(usdcReserveDataAfter.liquidityIndex.toString()).to.be.bignumber.gte(
      usdcReserveDataBefore.liquidityIndex.toString(),
      "Invalid liquidity index"
    );

    //the principal APY after a liquidation needs to be lower than the APY before
    expect(usdcReserveDataAfter.liquidityRate.toString()).to.be.bignumber.lt(
      usdcReserveDataBefore.liquidityRate.toString(),
      "Invalid liquidity APY"
    );

    expect(usdcReserveDataAfter.availableLiquidity.toString()).to.be.bignumber.almostEqual(
      new BigNumber(usdcReserveDataBefore.availableLiquidity.toString()).plus(expectedLiquidateAmount).toFixed(0),
      "Invalid principal available liquidity"
    );

    const tokenOwner = await bayc.ownerOf("102");
    expect(tokenOwner).to.be.equal(bBAYC.address, "Invalid token owner after redeem");
  });

  it("USDC - Redeems the borrow", async () => {
    const { usdc, bayc, users, pool, nftOracle, reserveOracle, dataProvider } = testEnv;
    const liquidator = users[3];
    const borrower = users[1];

    //mints USDC to borrower
    await usdc.connect(borrower.signer).mint(await convertToCurrencyDecimals(usdc.address, "1000000"));
    //approve protocol to access borrower wallet
    await usdc.connect(borrower.signer).approve(pool.address, APPROVAL_AMOUNT_LENDING_POOL);

    const nftCfgData = await dataProvider.getNftConfigurationData(bayc.address);

    const auctionDataBefore = await pool.getNftAuctionData(bayc.address, "102");

    const liquidatorBalanceBefore = await usdc.balanceOf(liquidator.address);

    // redeem duration
    await increaseTime(nftCfgData.redeemDuration.mul(ONE_DAY).sub(ONE_HOUR).toNumber());

    await pool.connect(borrower.signer).redeem(bayc.address, "102");

    // check result
    const tokenOwner = await bayc.ownerOf("102");
    expect(tokenOwner).to.be.equal(borrower.address, "Invalid token owner after redeem");

    const liquidatorBalanceAfter = await usdc.balanceOf(liquidator.address);
    expect(liquidatorBalanceAfter).to.be.equal(
      liquidatorBalanceBefore.add(auctionDataBefore.bidPrice).add(auctionDataBefore.bidFine),
      "Invalid liquidator balance after redeem"
    );
  });
});