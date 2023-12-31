# @sovryn-zero/sdk-contracts
  Zero API Libraries are utilities for the Sovryn Zero Protocol

## Quickstart
### Installation:

  ```shell 
  npm install @sovryn-zero/contracts @sovryn-zero/sdk-contracts
  ```

## Project Description
  Sovryn ZERO Solidity Contracts SDK is a set of solidity libraries that users can import and use in their contracts.
  Stashed changes

## Overview
  All contracts are libraries, each containing set of functionalities related to utilities of the Sovryn Zero ecosystem.

  The library cover several major utilities such as:

  1. **[BorrowerLib.sol](./docs/BorrowerLib.md)** - Borrower operations (Opening, Adjusting line of credit)
  2. **[LiquidationLib.sol](./docs/LiquidationLib.md)** - Liquidation & Redemption operations.
  3. **[StabilityPoolLib.sol](./docs/StabilityPoolLib.md)** - Pool Stability operations.
  4. **[TroveStatiscticsLib.sol](./docs/TroveStatisticsLib.md)** - View function related to the troves (get nominal collateral ratio, borrowing fee calculation, get borrower's debt of the troves).
   
  **[ZERO Contracts Addresses](docs/Addresses.md)**  
  **[ZERO RSK Testnet Contracts deployment data](deployments/deployment/rskSovrynTestnet)**  
  **[ZERO RSK Mainnet Contracts deployment data](deployments/deployment/rskSovrynTestnet)**  
  

## Demo
  **[TestLibraries.sol](docs/IntegrationExample.md)** provides a sample integration