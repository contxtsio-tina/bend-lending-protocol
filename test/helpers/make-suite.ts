import { evmRevert, evmSnapshot, DRE } from "../../helpers/misc-utils";
import { Signer } from "ethers";
import {
  getLendPool,
  getLendPoolAddressesProvider,
  getBendProtocolDataProvider,
  getBToken,
  getBNFT,
  getMintableERC20,
  getMintableERC721,
  getLendPoolConfiguratorProxy,
  getReserveOracle,
  getNFTOracle,
  getWETHMocked,
  getWETHGateway,
} from "../../helpers/contracts-getters";
import {
  eEthereumNetwork,
  eNetwork,
  tEthereumAddress,
} from "../../helpers/types";
import { LendPool } from "../../types/LendPool";
import { BendProtocolDataProvider } from "../../types/BendProtocolDataProvider";
import { MintableERC20 } from "../../types/MintableERC20";
import { BToken } from "../../types/BToken";
import { MintableERC721 } from "../../types/MintableERC721";
import { BNFT } from "../../types/BNFT";
import { LendPoolConfigurator } from "../../types/LendPoolConfigurator";

import chai from "chai";
// @ts-ignore
import bignumberChai from "chai-bignumber";
import { almostEqual } from "./almost-equal";
import { ReserveOracle } from "../../types/ReserveOracle";
import { NFTOracle } from "../../types/NFTOracle";
import { LendPoolAddressesProvider } from "../../types/LendPoolAddressesProvider";
import { getEthersSigners } from "../../helpers/contracts-helpers";
import { getParamPerNetwork } from "../../helpers/contracts-helpers";
import { WETH9Mocked } from "../../types/WETH9Mocked";
import { WETHGateway } from "../../types/WETHGateway";
import { solidity } from "ethereum-waffle";
import { BendConfig } from "../../markets/bend";
import { HardhatRuntimeEnvironment } from "hardhat/types";

chai.use(bignumberChai());
chai.use(almostEqual());
chai.use(solidity);

export interface SignerWithAddress {
  signer: Signer;
  address: tEthereumAddress;
}
export interface TestEnv {
  deployer: SignerWithAddress;
  users: SignerWithAddress[];
  pool: LendPool;
  configurator: LendPoolConfigurator;
  reserveOracle: ReserveOracle;
  nftOracle: NFTOracle;
  helpersContract: BendProtocolDataProvider;
  weth: WETH9Mocked;
  bWETH: BToken;
  dai: MintableERC20;
  bDai: BToken;
  usdc: MintableERC20;
  //wpunks: WPUNKSMocked;
  bPUNK: BNFT;
  bayc: MintableERC721;
  bBYAC: BNFT;
  addressesProvider: LendPoolAddressesProvider;
  wethGateway: WETHGateway;
}

let buidlerevmSnapshotId: string = "0x1";
const setBuidlerevmSnapshotId = (id: string) => {
  buidlerevmSnapshotId = id;
};

const testEnv: TestEnv = {
  deployer: {} as SignerWithAddress,
  users: [] as SignerWithAddress[],
  pool: {} as LendPool,
  configurator: {} as LendPoolConfigurator,
  helpersContract: {} as BendProtocolDataProvider,
  reserveOracle: {} as ReserveOracle,
  nftOracle: {} as NFTOracle,
  weth: {} as WETH9Mocked,
  bWETH: {} as BToken,
  dai: {} as MintableERC20,
  bDai: {} as BToken,
  //wpunks: WPUNKSMocked,
  bPUNK: {} as BNFT,
  bayc: {} as MintableERC721,
  bBYAC: {} as BNFT,
  addressesProvider: {} as LendPoolAddressesProvider,
  wethGateway: {} as WETHGateway,
  //wpunksGateway: {} as WPUNKSGateway,
} as TestEnv;

export async function initializeMakeSuite() {
  const [_deployer, ...restSigners] = await getEthersSigners();
  const deployer: SignerWithAddress = {
    address: await _deployer.getAddress(),
    signer: _deployer,
  };

  for (const signer of restSigners) {
    testEnv.users.push({
      signer,
      address: await signer.getAddress(),
    });
  }
  testEnv.deployer = deployer;
  testEnv.pool = await getLendPool();

  testEnv.configurator = await getLendPoolConfiguratorProxy();

  testEnv.addressesProvider = await getLendPoolAddressesProvider();

  testEnv.reserveOracle = await getReserveOracle();
  testEnv.nftOracle = await getNFTOracle();

  testEnv.helpersContract = await getBendProtocolDataProvider();

  // Reserve Tokens
  const allTokens = await testEnv.helpersContract.getAllBTokens();
  const bDaiAddress = allTokens.find(
    (bToken) => bToken.symbol === "bDAI"
  )?.tokenAddress;

  const bWEthAddress = allTokens.find(
    (bToken) => bToken.symbol === "bWETH"
  )?.tokenAddress;

  const reservesTokens = await testEnv.helpersContract.getAllReservesTokens();

  const daiAddress = reservesTokens.find(
    (token) => token.symbol === "DAI"
  )?.tokenAddress;
  const wethAddress = reservesTokens.find(
    (token) => token.symbol === "WETH"
  )?.tokenAddress;

  if (!bDaiAddress || !bWEthAddress) {
    console.error("Invalid BTokens", bDaiAddress, bWEthAddress);
    process.exit(1);
  }
  if (!daiAddress || !wethAddress) {
    console.error("Invalid Reserve Tokens", daiAddress, wethAddress);
    process.exit(1);
  }

  testEnv.bDai = await getBToken(bDaiAddress);
  testEnv.bWETH = await getBToken(bWEthAddress);

  testEnv.dai = await getMintableERC20(daiAddress);
  testEnv.weth = await getWETHMocked(wethAddress);
  //testEnv.wethGateway = await getWETHGateway();

  // NFT Tokens
  const allBNftTokens = await testEnv.helpersContract.getAllBNfts();
  //console.log("allBNftTokens", allBNftTokens);
  const bPunkAddress = allBNftTokens.find(
    (bNFT) => bNFT.symbol === "bWPUNKS"
  )?.nftAddress;

  const bByacAddress = allBNftTokens.find(
    (bNFT) => bNFT.symbol === "bBAYC"
  )?.nftAddress;

  const nftsTokens = await testEnv.helpersContract.getAllNftsTokens();
  //console.log("nftsTokens", nftsTokens);
  const wpunksAddress = nftsTokens.find(
    (token) => token.symbol === "WPUNKS"
  )?.nftAddress;
  const baycAddress = nftsTokens.find(
    (token) => token.symbol === "BAYC"
  )?.nftAddress;

  if (!bByacAddress || !bPunkAddress) {
    console.error("Invalid BNFTs", bByacAddress, bPunkAddress);
    process.exit(1);
  }
  if (!baycAddress || !wpunksAddress) {
    console.error("Invalid NFT Tokens", baycAddress, wpunksAddress);
    process.exit(1);
  }

  testEnv.bBYAC = await getBNFT(bByacAddress);
  testEnv.bPUNK = await getBNFT(bPunkAddress);

  testEnv.bayc = await getMintableERC721(baycAddress);
  //testEnv.wpunks = await getWPUNKSMocked(wpunksAddress);
  //testEnv.wpunksGateway = await getWPUNKSGateway();
}

const setSnapshot = async () => {
  const hre = DRE as HardhatRuntimeEnvironment;
  setBuidlerevmSnapshotId(await evmSnapshot());
};

const revertHead = async () => {
  const hre = DRE as HardhatRuntimeEnvironment;
  await evmRevert(buidlerevmSnapshotId);
};

export function makeSuite(name: string, tests: (testEnv: TestEnv) => void) {
  describe(name, () => {
    before(async () => {
      await setSnapshot();
    });
    tests(testEnv);
    after(async () => {
      await revertHead();
    });
  });
}