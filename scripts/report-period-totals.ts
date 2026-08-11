import fs from "fs";
import path from "path";

import hre from "hardhat";
import { Contract, Interface, formatUnits, toQuantity } from "ethers";

const DECIMAL_PRECISION = 10n ** 18n;
const CURRENT_STATE_VERSION = 3;

const TROVE_MANAGER_ABI = [
    "event TroveLiquidated(address indexed _borrower, uint256 _debt, uint256 _coll, uint8 _operation)",
    "event Redemption(uint256 _attemptedZUSDAmount, uint256 _actualZUSDAmount, uint256 _ETHSent, uint256 _ETHFee)",
];

const BORROWER_OPERATIONS_ABI = [
    "event ZUSDBorrowingFeePaid(address indexed _borrower, uint256 _ZUSDFee)",
    "function adjustTrove(uint256 _maxFeePercentage, uint256 _collWithdrawal, uint256 _ZUSDChange, bool _isDebtIncrease, address _upperHint, address _lowerHint)",
    "function adjustNueTrove(uint256 _maxFeePercentage, uint256 _collWithdrawal, uint256 _ZUSDChange, bool _isDebtIncrease, address _upperHint, address _lowerHint, tuple(uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permitParams)",
    "function adjustNueTroveWithPermit2(uint256 _maxFeePercentage, uint256 _collWithdrawal, uint256 _ZUSDChange, bool _isDebtIncrease, address _upperHint, address _lowerHint, tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) _permit, bytes _signature)",
    "function closeTrove()",
    "function closeNueTrove(tuple(uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permitParams)",
    "function closeNueTroveWithPermit2(tuple(tuple(address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) _permit, bytes _signature)",
];

const FEE_DISTRIBUTOR_ABI = [
    "event ZUSDDistributed(uint256 _zusdDistributedAmount)",
    "event RBTCistributed(uint256 _rbtcDistributedAmount)",
    "function FEE_TO_FEE_SHARING_COLLECTOR() view returns (uint256)",
    "function feeSharingCollector() view returns (address)",
];

const ACTIVE_POOL_ABI = ["event EtherSent(address _to, uint256 _amount)"];

type Args = {
    start: string;
    end?: string;
    chunkSize: number;
    sleepMs: number;
    stateFile?: string;
    force: boolean;
};

type ReportTotals = {
    liquidations: {
        troveCount: number;
        totalDebt: bigint;
        totalColl: bigint;
    };
    feesSentToFeeSharingCollector: {
        zusdTotal: bigint;
        rbtcTotal: bigint;
        zusdDistributionEvents: number;
        rbtcDistributionEvents: number;
    };
    redemptions: {
        count: number;
        attemptedZusd: bigint;
        actualZusd: bigint;
        rbtcSent: bigint;
        rbtcFee: bigint;
    };
    originationFees: {
        chargedCount: number;
        totalZusdFee: bigint;
    };
    rbtcRemovedViaDebtRepayment: {
        txCount: number;
        totalRbtc: bigint;
    };
    rbtcLockedInLinesOfCredit: {
        startTotalRbtc: bigint;
        endTotalRbtc: bigint;
    };
};

type SerializableReportState = {
    version: number;
    network: string;
    chainId: number;
    startInput: string;
    endInput: string | null;
    startTimestamp: number;
    endTimestamp: number;
    startBlock: number;
    endBlock: number;
    processedToBlock: number;
    chunkSize: number;
    sleepMs: number;
    contracts: {
        troveManager: string;
        borrowerOperations: string;
        feeDistributor: string;
        feeSharingCollector: string;
    };
    totals: {
        liquidations: {
            troveCount: number;
            totalDebt: string;
            totalColl: string;
        };
        feesSentToFeeSharingCollector: {
            zusdTotal: string;
            rbtcTotal: string;
            zusdDistributionEvents: number;
            rbtcDistributionEvents: number;
        };
        redemptions: {
            count: number;
            attemptedZusd: string;
            actualZusd: string;
            rbtcSent: string;
            rbtcFee: string;
        };
        originationFees: {
            chargedCount: number;
            totalZusdFee: string;
        };
        rbtcRemovedViaDebtRepayment: {
            txCount: number;
            totalRbtc: string;
        };
        rbtcLockedInLinesOfCredit: {
            startTotalRbtc: string;
            endTotalRbtc: string;
        };
    };
    finishedAt: string | null;
    updatedAt: string;
};

type RuntimeState = Omit<SerializableReportState, "totals"> & {
    totals: ReportTotals;
};

const troveManagerInterface = new Interface(TROVE_MANAGER_ABI);
const borrowerOperationsInterface = new Interface(BORROWER_OPERATIONS_ABI);
const feeDistributorInterface = new Interface(FEE_DISTRIBUTOR_ABI);
const activePoolInterface = new Interface(ACTIVE_POOL_ABI);

const sleep = async (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertCondition(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

const toBigInt = (value: unknown): bigint => {
    if (typeof value === "bigint") {
        return value;
    }

    if (typeof value === "number") {
        return BigInt(value);
    }

    if (typeof value === "string") {
        return BigInt(value);
    }

    throw new Error(`Cannot convert value to bigint: ${String(value)}`);
};

const format18 = (value: bigint) => formatUnits(value, 18);

const formatTimestamp = (timestamp: number) => new Date(timestamp * 1000).toISOString();

const sanitizeForFilename = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_");

const buildDefaultStateFile = (networkName: string, start: string, end?: string) => {
    const fileName = `period-totals-${sanitizeForFilename(networkName)}-${sanitizeForFilename(
        start
    )}-${sanitizeForFilename(end ?? "now")}.json`;
    return path.join(process.cwd(), "reports", fileName);
};

const getFeeSharingCollectorFallback = (networkName: string) => {
    const artifactByNetwork: Record<string, string> = {
        rskSovrynMainnet: path.join(
            process.cwd(),
            "external",
            "deployments",
            "rskMainnet",
            "IFeeSharingCollector.json"
        ),
        rskSovrynTestnet: path.join(
            process.cwd(),
            "external",
            "deployments",
            "rskTestnet",
            "IFeeSharingCollector.json"
        ),
    };

    const artifactPath = artifactByNetwork[networkName];
    if (!artifactPath || !fs.existsSync(artifactPath)) {
        return "unknown";
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { address?: string };
    return artifact.address ?? "unknown";
};

const emptyTotals = (): ReportTotals => ({
    liquidations: {
        troveCount: 0,
        totalDebt: 0n,
        totalColl: 0n,
    },
    feesSentToFeeSharingCollector: {
        zusdTotal: 0n,
        rbtcTotal: 0n,
        zusdDistributionEvents: 0,
        rbtcDistributionEvents: 0,
    },
    redemptions: {
        count: 0,
        attemptedZusd: 0n,
        actualZusd: 0n,
        rbtcSent: 0n,
        rbtcFee: 0n,
    },
    originationFees: {
        chargedCount: 0,
        totalZusdFee: 0n,
    },
    rbtcRemovedViaDebtRepayment: {
        txCount: 0,
        totalRbtc: 0n,
    },
    rbtcLockedInLinesOfCredit: {
        startTotalRbtc: 0n,
        endTotalRbtc: 0n,
    },
});

const serializeState = (state: RuntimeState): SerializableReportState => ({
    ...state,
    totals: {
        liquidations: {
            troveCount: state.totals.liquidations.troveCount,
            totalDebt: state.totals.liquidations.totalDebt.toString(),
            totalColl: state.totals.liquidations.totalColl.toString(),
        },
        feesSentToFeeSharingCollector: {
            zusdTotal: state.totals.feesSentToFeeSharingCollector.zusdTotal.toString(),
            rbtcTotal: state.totals.feesSentToFeeSharingCollector.rbtcTotal.toString(),
            zusdDistributionEvents:
                state.totals.feesSentToFeeSharingCollector.zusdDistributionEvents,
            rbtcDistributionEvents:
                state.totals.feesSentToFeeSharingCollector.rbtcDistributionEvents,
        },
        redemptions: {
            count: state.totals.redemptions.count,
            attemptedZusd: state.totals.redemptions.attemptedZusd.toString(),
            actualZusd: state.totals.redemptions.actualZusd.toString(),
            rbtcSent: state.totals.redemptions.rbtcSent.toString(),
            rbtcFee: state.totals.redemptions.rbtcFee.toString(),
        },
        originationFees: {
            chargedCount: state.totals.originationFees.chargedCount,
            totalZusdFee: state.totals.originationFees.totalZusdFee.toString(),
        },
        rbtcRemovedViaDebtRepayment: {
            txCount: state.totals.rbtcRemovedViaDebtRepayment.txCount,
            totalRbtc: state.totals.rbtcRemovedViaDebtRepayment.totalRbtc.toString(),
        },
        rbtcLockedInLinesOfCredit: {
            startTotalRbtc: state.totals.rbtcLockedInLinesOfCredit.startTotalRbtc.toString(),
            endTotalRbtc: state.totals.rbtcLockedInLinesOfCredit.endTotalRbtc.toString(),
        },
    },
});

const deserializeState = (state: SerializableReportState): RuntimeState => ({
    ...state,
    totals: {
        liquidations: {
            troveCount: state.totals.liquidations.troveCount,
            totalDebt: BigInt(state.totals.liquidations.totalDebt),
            totalColl: BigInt(state.totals.liquidations.totalColl),
        },
        feesSentToFeeSharingCollector: {
            zusdTotal: BigInt(state.totals.feesSentToFeeSharingCollector.zusdTotal),
            rbtcTotal: BigInt(state.totals.feesSentToFeeSharingCollector.rbtcTotal),
            zusdDistributionEvents:
                state.totals.feesSentToFeeSharingCollector.zusdDistributionEvents,
            rbtcDistributionEvents:
                state.totals.feesSentToFeeSharingCollector.rbtcDistributionEvents,
        },
        redemptions: {
            count: state.totals.redemptions.count,
            attemptedZusd: BigInt(state.totals.redemptions.attemptedZusd),
            actualZusd: BigInt(state.totals.redemptions.actualZusd),
            rbtcSent: BigInt(state.totals.redemptions.rbtcSent),
            rbtcFee: BigInt(state.totals.redemptions.rbtcFee),
        },
        originationFees: {
            chargedCount: state.totals.originationFees.chargedCount,
            totalZusdFee: BigInt(state.totals.originationFees.totalZusdFee),
        },
        rbtcRemovedViaDebtRepayment: {
            txCount: state.totals.rbtcRemovedViaDebtRepayment?.txCount ?? 0,
            totalRbtc: BigInt(state.totals.rbtcRemovedViaDebtRepayment?.totalRbtc ?? "0"),
        },
        rbtcLockedInLinesOfCredit: {
            startTotalRbtc: BigInt(
                state.totals.rbtcLockedInLinesOfCredit?.startTotalRbtc ?? "0"
            ),
            endTotalRbtc: BigInt(state.totals.rbtcLockedInLinesOfCredit?.endTotalRbtc ?? "0"),
        },
    },
});

const saveState = (stateFile: string, state: RuntimeState) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const serialized = serializeState({
        ...state,
        updatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(stateFile, JSON.stringify(serialized, null, 2));
};

const loadState = (stateFile: string): RuntimeState | null => {
    if (!fs.existsSync(stateFile)) {
        return null;
    }

    const raw = fs.readFileSync(stateFile, "utf8");
    return deserializeState(JSON.parse(raw) as SerializableReportState);
};

const parseDateInput = (value: string, endOfDay: boolean) => {
    if (/^\d+$/.test(value)) {
        return Number(value);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        // Date-only ranges are inclusive and non-overlapping in UTC:
        // start dates map to 00:00:00, end dates map to 23:59:59.
        const suffix = endOfDay ? "T23:59:59.000Z" : "T00:00:00.000Z";
        const parsed = Date.parse(`${value}${suffix}`);
        assertCondition(!Number.isNaN(parsed), `Invalid date: ${value}`);
        return Math.floor(parsed / 1000);
    }

    const parsed = Date.parse(value);
    assertCondition(!Number.isNaN(parsed), `Invalid date: ${value}`);
    return Math.floor(parsed / 1000);
};

const parseArgs = (): Args => {
    const argv = process.argv.slice(2);
    const args: Partial<Args> = {
        chunkSize: 2_000,
        sleepMs: 250,
        force: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        switch (arg) {
            case "--start":
                args.start = next;
                i += 1;
                break;
            case "--end":
                args.end = next;
                i += 1;
                break;
            case "--chunk-size":
                args.chunkSize = Number(next);
                i += 1;
                break;
            case "--sleep-ms":
                args.sleepMs = Number(next);
                i += 1;
                break;
            case "--state-file":
                args.stateFile = next;
                i += 1;
                break;
            case "--force":
                args.force = true;
                break;
            case "--help":
                console.log(`Usage:
  yarn report:period-totals --network <network> --start <date> [--end <date>] [--chunk-size 2000] [--sleep-ms 250] [--state-file <path>] [--force]

Date inputs:
  - Unix timestamp in seconds
  - ISO datetime
  - YYYY-MM-DD (interpreted in UTC; start uses 00:00:00, end uses 23:59:59)
`);
                process.exit(0);
                break;
            default:
                if (arg.startsWith("--")) {
                    throw new Error(`Unknown argument: ${arg}`);
                }
        }
    }

    assertCondition(args.start, "Missing required --start argument");
    assertCondition(
        Number.isInteger(args.chunkSize) && (args.chunkSize ?? 0) > 0,
        "--chunk-size must be a positive integer"
    );
    assertCondition(
        Number.isInteger(args.sleepMs) && (args.sleepMs ?? -1) >= 0,
        "--sleep-ms must be a non-negative integer"
    );

    return args as Args;
};

const withRetry = async <T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt === maxAttempts) {
                break;
            }

            const delayMs = attempt * 1_000;
            console.warn(`${label} failed on attempt ${attempt}/${maxAttempts}. Retrying in ${delayMs}ms.`);
            await sleep(delayMs);
        }
    }

    throw lastError;
};

const requireBlock = async (provider: any, blockTag: number | "latest") => {
    const block = await provider.getBlock(blockTag);
    assertCondition(block, `Block ${String(blockTag)} not found`);
    return block;
};

const parseRequiredLog = (
    contractInterface: Interface,
    log: { data: string; topics: readonly string[] }
) => {
    const parsed = contractInterface.parseLog({
        data: log.data,
        topics: [...log.topics],
    });
    assertCondition(parsed, "Failed to parse log");
    return parsed;
};

const getLogsRaw = async (
    provider: any,
    filter: {
        address: string;
        fromBlock: number;
        toBlock: number;
        topics: Array<string | string[] | null>;
    }
) => {
    const rawLogs = (await provider.send("eth_getLogs", [
        {
            address: filter.address,
            fromBlock: toQuantity(filter.fromBlock),
            toBlock: toQuantity(filter.toBlock),
            topics: filter.topics,
        },
    ])) as Array<{
        address: string;
        blockHash?: string;
        blockNumber: string;
        data: string;
        logIndex: string;
        removed?: boolean;
        topics: string[];
        transactionHash?: string;
        transactionIndex?: string;
    }>;

    return rawLogs.map((log) => ({
        address: log.address,
        blockHash: log.blockHash,
        blockNumber: Number(log.blockNumber),
        data: log.data,
        logIndex: Number(log.logIndex),
        removed: log.removed ?? false,
        topics: log.topics,
        transactionHash: log.transactionHash,
        transactionIndex:
            log.transactionIndex !== undefined ? Number(log.transactionIndex) : undefined,
    }));
};

const getStorageAtRaw = async (
    provider: any,
    address: string,
    slot: number,
    blockNumber?: number
) => {
    return (await provider.send("eth_getStorageAt", [
        address,
        toQuantity(slot),
        blockNumber !== undefined ? toQuantity(blockNumber) : "latest",
    ])) as string;
};

const decodeAddressFromStorage = (value: string) => {
    if (!value || value === "0x") {
        return "0x0000000000000000000000000000000000000000";
    }

    return `0x${value.slice(-40)}`;
};

const decodeUintFromStorage = (value: string) => BigInt(value || "0x0");

const getTransactionByHashRaw = async (provider: any, txHash: string) => {
    return (await provider.send("eth_getTransactionByHash", [txHash])) as {
        to?: string | null;
        input?: string;
    } | null;
};

const main = async () => {
    const args = parseArgs();
    const { ethers, deployments } = hre as any;
    const provider = ethers.provider;
    const networkInfo = await provider.getNetwork();
    const networkName = hre.network.name;
    const { get } = deployments;

    const troveManagerDeployment = await get("TroveManager");
    const borrowerOperationsDeployment = await get("BorrowerOperations");
    const feeDistributorDeployment = await get("FeeDistributor");
    const activePoolDeployment = await get("ActivePool");
    const defaultPoolDeployment = await get("DefaultPool");

    let feeSharingCollectorAddress = getFeeSharingCollectorFallback(networkName);
    try {
        feeSharingCollectorAddress = decodeAddressFromStorage(
            await getStorageAtRaw(provider, feeDistributorDeployment.address, 0)
        );
    } catch (error) {
        console.warn(
            `Unable to read feeSharingCollector() from FeeDistributor. Continuing with fallback address: ${feeSharingCollectorAddress}`
        );
    }

    const stateFile =
        args.stateFile ?? buildDefaultStateFile(networkName, args.start, args.end ?? "now");

    if (args.force && fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
    }

    let state = loadState(stateFile);

    if (state !== null && state.version !== CURRENT_STATE_VERSION) {
        console.warn(
            `State file version ${state.version} is outdated for this report format. Restarting from scratch with version ${CURRENT_STATE_VERSION}.`
        );
        state = null;
    }

    if (state === null) {
        const startTimestamp = parseDateInput(args.start, false);
        const endTimestamp = args.end
            ? parseDateInput(args.end, true)
            : Math.floor(Date.now() / 1000);

        assertCondition(endTimestamp >= startTimestamp, "End timestamp must be >= start timestamp");

        const blockCache = new Map<number, number>();
        const getBlockTimestamp = async (blockNumber: number) => {
            const cached = blockCache.get(blockNumber);
            if (cached !== undefined) {
                return cached;
            }

            const block = await withRetry(`getBlock(${blockNumber})`, async () => {
                return requireBlock(provider, blockNumber);
            });
            const timestamp = Number(block.timestamp);
            blockCache.set(blockNumber, timestamp);
            return timestamp;
        };

        const findFirstBlockAtOrAfter = async (targetTimestamp: number) => {
            const latestBlock = await withRetry("getBlock(latest)", async () => {
                return requireBlock(provider, "latest");
            });
            const latestBlockNumber = Number(latestBlock.number);
            const latestTimestamp = Number(latestBlock.timestamp);

            if (targetTimestamp <= (await getBlockTimestamp(0))) {
                return 0;
            }

            if (targetTimestamp > latestTimestamp) {
                return latestBlockNumber;
            }

            let low = 0;
            let high = latestBlockNumber;

            while (low < high) {
                const mid = Math.floor((low + high) / 2);
                const midTimestamp = await getBlockTimestamp(mid);

                if (midTimestamp >= targetTimestamp) {
                    high = mid;
                } else {
                    low = mid + 1;
                }
            }

            return low;
        };

        const findLastBlockAtOrBefore = async (targetTimestamp: number) => {
            const latestBlock = await withRetry("getBlock(latest)", async () => {
                return requireBlock(provider, "latest");
            });
            const latestBlockNumber = Number(latestBlock.number);
            const latestTimestamp = Number(latestBlock.timestamp);

            if (targetTimestamp >= latestTimestamp) {
                return latestBlockNumber;
            }

            const firstAfter = await findFirstBlockAtOrAfter(targetTimestamp + 1);
            return Math.max(0, firstAfter - 1);
        };

        console.log(`Resolving blocks for ${formatTimestamp(startTimestamp)} -> ${formatTimestamp(endTimestamp)}...`);

        const startBlock = await findFirstBlockAtOrAfter(startTimestamp);
        const endBlock = await findLastBlockAtOrBefore(endTimestamp);
        const startActivePoolEth = decodeUintFromStorage(
            await withRetry(`storage(ActivePool.ETH)@${startBlock}`, () =>
                getStorageAtRaw(provider, activePoolDeployment.address, 4, startBlock)
            )
        );
        const startDefaultPoolEth = decodeUintFromStorage(
            await withRetry(`storage(DefaultPool.ETH)@${startBlock}`, () =>
                getStorageAtRaw(provider, defaultPoolDeployment.address, 2, startBlock)
            )
        );
        const endActivePoolEth = decodeUintFromStorage(
            await withRetry(`storage(ActivePool.ETH)@${endBlock}`, () =>
                getStorageAtRaw(provider, activePoolDeployment.address, 4, endBlock)
            )
        );
        const endDefaultPoolEth = decodeUintFromStorage(
            await withRetry(`storage(DefaultPool.ETH)@${endBlock}`, () =>
                getStorageAtRaw(provider, defaultPoolDeployment.address, 2, endBlock)
            )
        );

        state = {
            version: CURRENT_STATE_VERSION,
            network: networkName,
            chainId: Number(networkInfo.chainId),
            startInput: args.start,
            endInput: args.end ?? null,
            startTimestamp,
            endTimestamp,
            startBlock,
            endBlock,
            processedToBlock: startBlock - 1,
            chunkSize: args.chunkSize,
            sleepMs: args.sleepMs,
            contracts: {
                troveManager: troveManagerDeployment.address,
                borrowerOperations: borrowerOperationsDeployment.address,
                feeDistributor: feeDistributorDeployment.address,
                feeSharingCollector: feeSharingCollectorAddress,
            },
            totals: {
                ...emptyTotals(),
                rbtcLockedInLinesOfCredit: {
                    startTotalRbtc: startActivePoolEth + startDefaultPoolEth,
                    endTotalRbtc: endActivePoolEth + endDefaultPoolEth,
                },
            },
            finishedAt: null,
            updatedAt: new Date().toISOString(),
        };

        saveState(stateFile, state);
    } else {
        assertCondition(state.network === networkName, `State file network mismatch: ${state.network}`);
        assertCondition(
            state.chainId === Number(networkInfo.chainId),
            `State file chainId mismatch: ${state.chainId}`
        );
        assertCondition(
            state.startInput === args.start,
            `State file start mismatch: ${state.startInput} !== ${args.start}`
        );
        assertCondition(
            state.endInput === (args.end ?? null),
            `State file end mismatch: ${state.endInput} !== ${args.end ?? null}`
        );
        assertCondition(
            state.contracts.troveManager.toLowerCase() === troveManagerDeployment.address.toLowerCase(),
            "State file TroveManager address mismatch"
        );
        assertCondition(
            state.contracts.borrowerOperations.toLowerCase() ===
                borrowerOperationsDeployment.address.toLowerCase(),
            "State file BorrowerOperations address mismatch"
        );
        assertCondition(
            state.contracts.feeDistributor.toLowerCase() === feeDistributorDeployment.address.toLowerCase(),
            "State file FeeDistributor address mismatch"
        );
    }

    assertCondition(state !== null, "State initialization failed");
    const runtimeState: RuntimeState = state;

    assertCondition(runtimeState.startBlock <= runtimeState.endBlock, "Resolved start block is after end block");

    if (runtimeState.finishedAt !== null || runtimeState.processedToBlock >= runtimeState.endBlock) {
        console.log(`State file already completed: ${stateFile}`);
        printSummary(runtimeState, stateFile);
        return;
    }

    const ratioCache = new Map<number, bigint>();
    const transactionCache = new Map<string, { to?: string | null; input?: string } | null>();

    const getCollectorRatioAtBlock = async (blockNumber: number) => {
        const cached = ratioCache.get(blockNumber);
        if (cached !== undefined) {
            return cached;
        }

        const ratio = BigInt(
            await withRetry(`storage(FEE_TO_FEE_SHARING_COLLECTOR)@${blockNumber}`, async () =>
                getStorageAtRaw(provider, state.contracts.feeDistributor, 7, blockNumber)
            )
        );
        ratioCache.set(blockNumber, ratio);
        return ratio;
    };

    const getTransactionByHashCached = async (txHash: string) => {
        const cached = transactionCache.get(txHash);
        if (cached !== undefined) {
            return cached;
        }

        const tx = await withRetry(`eth_getTransactionByHash(${txHash})`, () =>
            getTransactionByHashRaw(provider, txHash)
        );
        transactionCache.set(txHash, tx);
        return tx;
    };

    const endBlock = runtimeState.endBlock;
    let fromBlock = Math.max(runtimeState.startBlock, runtimeState.processedToBlock + 1);

    console.log(
        `Processing blocks ${fromBlock} -> ${endBlock} in chunks of ${args.chunkSize}. State: ${stateFile}`
    );

    while (fromBlock <= endBlock) {
        const toBlock = Math.min(fromBlock + args.chunkSize - 1, endBlock);
        console.log(`Chunk ${fromBlock} -> ${toBlock}`);

        const troveLiquidationLogs = await withRetry(
            `getLogs(TroveLiquidated ${fromBlock}-${toBlock})`,
            () =>
                getLogsRaw(provider, {
                    address: state.contracts.troveManager,
                    fromBlock,
                    toBlock,
                    topics: [troveManagerInterface.getEvent("TroveLiquidated").topicHash],
                })
        );

        for (const log of troveLiquidationLogs) {
            const parsed = parseRequiredLog(troveManagerInterface, log);
            runtimeState.totals.liquidations.troveCount += 1;
            runtimeState.totals.liquidations.totalDebt += toBigInt(parsed.args._debt);
            runtimeState.totals.liquidations.totalColl += toBigInt(parsed.args._coll);
        }

        const redemptionLogs = await withRetry(`getLogs(Redemption ${fromBlock}-${toBlock})`, () =>
            getLogsRaw(provider, {
                address: state.contracts.troveManager,
                fromBlock,
                toBlock,
                topics: [troveManagerInterface.getEvent("Redemption").topicHash],
            })
        );

        for (const log of redemptionLogs) {
            const parsed = parseRequiredLog(troveManagerInterface, log);
            runtimeState.totals.redemptions.count += 1;
            runtimeState.totals.redemptions.attemptedZusd += toBigInt(parsed.args._attemptedZUSDAmount);
            runtimeState.totals.redemptions.actualZusd += toBigInt(parsed.args._actualZUSDAmount);
            runtimeState.totals.redemptions.rbtcSent += toBigInt(parsed.args._ETHSent);
            runtimeState.totals.redemptions.rbtcFee += toBigInt(parsed.args._ETHFee);
        }

        const originationLogs = await withRetry(
            `getLogs(ZUSDBorrowingFeePaid ${fromBlock}-${toBlock})`,
            () =>
                getLogsRaw(provider, {
                    address: state.contracts.borrowerOperations,
                    fromBlock,
                    toBlock,
                    topics: [borrowerOperationsInterface.getEvent("ZUSDBorrowingFeePaid").topicHash],
                })
        );

        for (const log of originationLogs) {
            const parsed = parseRequiredLog(borrowerOperationsInterface, log);
            const fee = toBigInt(parsed.args._ZUSDFee);
            if (fee === 0n) {
                continue;
            }

            runtimeState.totals.originationFees.chargedCount += 1;
            runtimeState.totals.originationFees.totalZusdFee += fee;
        }

        const zusdDistributedLogs = await withRetry(
            `getLogs(ZUSDDistributed ${fromBlock}-${toBlock})`,
            () =>
                getLogsRaw(provider, {
                    address: state.contracts.feeDistributor,
                    fromBlock,
                    toBlock,
                    topics: [feeDistributorInterface.getEvent("ZUSDDistributed").topicHash],
                })
        );

        for (const log of zusdDistributedLogs) {
            const parsed = parseRequiredLog(feeDistributorInterface, log);
            const amount = toBigInt(parsed.args._zusdDistributedAmount);
            const ratio = await getCollectorRatioAtBlock(Number(log.blockNumber));
            const collectorAmount = (amount * ratio) / DECIMAL_PRECISION;

            runtimeState.totals.feesSentToFeeSharingCollector.zusdDistributionEvents += 1;
            runtimeState.totals.feesSentToFeeSharingCollector.zusdTotal += collectorAmount;
        }

        const rbtcDistributedLogs = await withRetry(
            `getLogs(RBTCistributed ${fromBlock}-${toBlock})`,
            () =>
                getLogsRaw(provider, {
                    address: state.contracts.feeDistributor,
                    fromBlock,
                    toBlock,
                    topics: [feeDistributorInterface.getEvent("RBTCistributed").topicHash],
                })
        );

        for (const log of rbtcDistributedLogs) {
            const parsed = parseRequiredLog(feeDistributorInterface, log);
            const amount = toBigInt(parsed.args._rbtcDistributedAmount);
            const ratio = await getCollectorRatioAtBlock(Number(log.blockNumber));
            const collectorAmount = (amount * ratio) / DECIMAL_PRECISION;

            runtimeState.totals.feesSentToFeeSharingCollector.rbtcDistributionEvents += 1;
            runtimeState.totals.feesSentToFeeSharingCollector.rbtcTotal += collectorAmount;
        }

        const activePoolEtherSentLogs = await withRetry(
            `getLogs(ActivePool EtherSent ${fromBlock}-${toBlock})`,
            () =>
                getLogsRaw(provider, {
                    address: activePoolDeployment.address,
                    fromBlock,
                    toBlock,
                    topics: [activePoolInterface.getEvent("EtherSent").topicHash],
                })
        );

        const countedDebtRepaymentTxs = new Set<string>();
        for (const log of activePoolEtherSentLogs) {
            if (!log.transactionHash || countedDebtRepaymentTxs.has(log.transactionHash)) {
                continue;
            }

            const tx = await getTransactionByHashCached(log.transactionHash);
            if (!tx?.to || tx.to.toLowerCase() !== state.contracts.borrowerOperations.toLowerCase()) {
                continue;
            }

            const input = tx.input ?? "0x";
            if (input === "0x") {
                continue;
            }

            let parsedTx;
            try {
                parsedTx = borrowerOperationsInterface.parseTransaction({ data: input });
            } catch (error) {
                continue;
            }

            if (!parsedTx) {
                continue;
            }

            let shouldCount = false;
            switch (parsedTx.name) {
                case "closeTrove":
                case "closeNueTrove":
                case "closeNueTroveWithPermit2":
                    shouldCount = true;
                    break;
                case "adjustTrove":
                case "adjustNueTrove":
                case "adjustNueTroveWithPermit2": {
                    const collWithdrawal = toBigInt(parsedTx.args._collWithdrawal);
                    const debtChange = toBigInt(parsedTx.args._ZUSDChange);
                    const isDebtIncrease = Boolean(parsedTx.args._isDebtIncrease);
                    shouldCount = !isDebtIncrease && collWithdrawal > 0n && debtChange > 0n;
                    break;
                }
                default:
                    break;
            }

            if (!shouldCount) {
                continue;
            }

            const relatedLogs = activePoolEtherSentLogs.filter(
                (entry) => entry.transactionHash === log.transactionHash
            );
            const totalRemovedInTx = relatedLogs.reduce((sum, entry) => {
                const parsedLog = parseRequiredLog(activePoolInterface, entry);
                return sum + toBigInt(parsedLog.args._amount);
            }, 0n);

            countedDebtRepaymentTxs.add(log.transactionHash);
            runtimeState.totals.rbtcRemovedViaDebtRepayment.txCount += 1;
            runtimeState.totals.rbtcRemovedViaDebtRepayment.totalRbtc += totalRemovedInTx;
        }

        runtimeState.processedToBlock = toBlock;
        saveState(stateFile, runtimeState);

        const progress = (
            ((toBlock - runtimeState.startBlock + 1) /
                (runtimeState.endBlock - runtimeState.startBlock + 1)) *
            100
        ).toFixed(2);
        console.log(
            `Saved progress ${progress}% (${runtimeState.processedToBlock}/${runtimeState.endBlock})`
        );

        fromBlock = toBlock + 1;

        if (fromBlock <= endBlock && args.sleepMs > 0) {
            await sleep(args.sleepMs);
        }
    }

    runtimeState.finishedAt = new Date().toISOString();
    saveState(stateFile, runtimeState);
    printSummary(runtimeState, stateFile);
};

const printSummary = (state: RuntimeState, stateFile: string) => {
    console.log("");
    console.log("Period totals report");
    console.log(`State file: ${stateFile}`);
    console.log(
        `Range: ${formatTimestamp(state.startTimestamp)} -> ${formatTimestamp(state.endTimestamp)}`
    );
    console.log(`Blocks: ${state.startBlock} -> ${state.endBlock}`);
    console.log("");
    console.log("Lines of credit liquidations");
    console.log(`  Count: ${state.totals.liquidations.troveCount}`);
    console.log(`  Debt:  ${format18(state.totals.liquidations.totalDebt)} ZUSD`);
    console.log(`  Coll:  ${format18(state.totals.liquidations.totalColl)} RBTC`);
    console.log("");
    console.log("Fees sent to FeeSharingCollector");
    console.log(
        `  ZUSD: ${format18(state.totals.feesSentToFeeSharingCollector.zusdTotal)} ZUSD across ${state.totals.feesSentToFeeSharingCollector.zusdDistributionEvents} distribution events`
    );
    console.log(
        `  RBTC: ${format18(state.totals.feesSentToFeeSharingCollector.rbtcTotal)} RBTC across ${state.totals.feesSentToFeeSharingCollector.rbtcDistributionEvents} distribution events`
    );
    console.log("");
    console.log("Redemptions");
    console.log(`  Count:        ${state.totals.redemptions.count}`);
    console.log(`  Attempted:    ${format18(state.totals.redemptions.attemptedZusd)} ZUSD`);
    console.log(`  Actual:       ${format18(state.totals.redemptions.actualZusd)} ZUSD`);
    console.log(`  RBTC sent:    ${format18(state.totals.redemptions.rbtcSent)} RBTC`);
    console.log(`  RBTC fee:     ${format18(state.totals.redemptions.rbtcFee)} RBTC`);
    console.log("");
    console.log("Origination fees");
    console.log(`  Charged count: ${state.totals.originationFees.chargedCount}`);
    console.log(`  Total:         ${format18(state.totals.originationFees.totalZusdFee)} ZUSD`);
    console.log("");
    console.log("RBTC removed via debt repayment");
    console.log(`  Tx count: ${state.totals.rbtcRemovedViaDebtRepayment.txCount}`);
    console.log(`  Total:    ${format18(state.totals.rbtcRemovedViaDebtRepayment.totalRbtc)} RBTC`);
    console.log("");
    console.log("RBTC locked in Lines of Credits");
    console.log(`  At start: ${format18(state.totals.rbtcLockedInLinesOfCredit.startTotalRbtc)} RBTC`);
    console.log(`  At end:   ${format18(state.totals.rbtcLockedInLinesOfCredit.endTotalRbtc)} RBTC`);
    console.log("");
};

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
