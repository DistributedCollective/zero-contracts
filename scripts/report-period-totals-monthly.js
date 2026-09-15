const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { formatUnits } = require("ethers");

const DEFAULT_START = "2021-02-12";

const parseArgs = () => {
    const argv = process.argv.slice(2);
    const args = {
        network: null,
        from: DEFAULT_START,
        to: null,
        chunkSize: null,
        sleepMs: null,
        csvFile: null,
        reportsOnly: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];

        switch (arg) {
            case "--network":
                args.network = next;
                i += 1;
                break;
            case "--from":
                args.from = next;
                i += 1;
                break;
            case "--to":
                args.to = next;
                i += 1;
                break;
            case "--chunk-size":
                args.chunkSize = next;
                i += 1;
                break;
            case "--sleep-ms":
                args.sleepMs = next;
                i += 1;
                break;
            case "--csv-file":
                args.csvFile = next;
                i += 1;
                break;
            case "--reports-only":
                args.reportsOnly = true;
                break;
            case "--help":
                console.log(`Usage:
  yarn report:period-totals-monthly --network <network> [--from 2021-02-12] [--to YYYY-MM-DD] [--chunk-size 2000] [--sleep-ms 250] [--csv-file <path>] [--reports-only]

Behavior:
  - Generates one report for 2021-02-12 through 2021-02-28
  - Then generates monthly reports up to the provided end date, or today's UTC date if omitted
  - Writes one CSV row per period
`);
                process.exit(0);
                break;
            default:
                if (arg.startsWith("--")) {
                    throw new Error(`Unknown argument: ${arg}`);
                }
        }
    }

    if (!args.network) {
        throw new Error("Missing required --network <name> argument");
    }

    return args;
};

const assertDateOnly = (value, label) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`${label} must be in YYYY-MM-DD format`);
    }
};

const parseUtcDate = (value) => {
    assertDateOnly(value, value);
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
};

const formatUtcDate = (date) => {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
};

const getTodayUtcDate = () => {
    const now = new Date();
    return formatUtcDate(
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    );
};

const getEndOfMonthUtc = (date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));

const getStartOfNextMonthUtc = (date) =>
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));

const compareDates = (left, right) => left.getTime() - right.getTime();

const minDate = (left, right) => (compareDates(left, right) <= 0 ? left : right);

const buildPeriods = (from, to) => {
    const periods = [];
    let currentStart = parseUtcDate(from);
    const finalEnd = parseUtcDate(to);

    if (compareDates(currentStart, finalEnd) > 0) {
        throw new Error("--from must be <= --to");
    }

    while (compareDates(currentStart, finalEnd) <= 0) {
        const currentEnd = minDate(getEndOfMonthUtc(currentStart), finalEnd);
        periods.push({
            start: formatUtcDate(currentStart),
            end: formatUtcDate(currentEnd),
            label: `${formatUtcDate(currentStart)}..${formatUtcDate(currentEnd)}`,
        });
        currentStart = getStartOfNextMonthUtc(currentStart);
    }

    return periods;
};

const sanitizeForFilename = (value) => value.replace(/[^a-zA-Z0-9._-]+/g, "_");

const buildReportPath = (network, start, end) =>
    path.join(
        process.cwd(),
        "reports",
        `period-totals-${sanitizeForFilename(network)}-${sanitizeForFilename(
            start
        )}-${sanitizeForFilename(end)}.json`
    );

const buildCsvPath = (network, from, to) =>
    path.join(
        process.cwd(),
        "reports",
        `period-totals-monthly-${sanitizeForFilename(network)}-${sanitizeForFilename(
            from
        )}-${sanitizeForFilename(to)}.csv`
    );

const runPeriodReport = (network, period, args) => {
    const commandArgs = [
        "scripts/run-period-totals.js",
        "--network",
        network,
        "--start",
        period.start,
        "--end",
        period.end,
    ];

    if (args.chunkSize) {
        commandArgs.push("--chunk-size", args.chunkSize);
    }

    if (args.sleepMs) {
        commandArgs.push("--sleep-ms", args.sleepMs);
    }

    const result = spawnSync(process.execPath, commandArgs, {
        stdio: "inherit",
        env: {
            ...process.env,
            __decryptionAlreadyDone__: "TRUE",
        },
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        process.exit(result.status === null ? 1 : result.status);
    }
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const csvEscape = (value) => {
    if (value === null || value === undefined) {
        return "";
    }

    const stringValue = String(value);
    if (/[",\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
};

const format18 = (value) => formatUnits(BigInt(value), 18);

const buildCsvRows = (periods, network) => {
    const headers = [
        "period_label",
        "start_date",
        "end_date",
        "start_block",
        "end_block",
        "liquidations_count",
        "liquidations_debt_zusd",
        "liquidations_coll_rbtc",
        "fees_to_fee_sharing_collector_zusd",
        "fees_to_fee_sharing_collector_rbtc",
        "redemptions_count",
        "redemptions_attempted_zusd",
        "redemptions_actual_zusd",
        "redemptions_rbtc_sent",
        "redemptions_rbtc_fee",
        "origination_fee_count",
        "origination_fee_zusd",
        "rbtc_removed_via_debt_repayment_tx_count",
        "rbtc_removed_via_debt_repayment_total",
        "rbtc_locked_start",
        "rbtc_locked_end",
    ];

    const rows = [headers.join(",")];

    for (const period of periods) {
        const reportPath = buildReportPath(network, period.start, period.end);
        if (!fs.existsSync(reportPath)) {
            throw new Error(`Missing report file: ${reportPath}`);
        }

        const report = readJson(reportPath);
        const row = [
            period.label,
            period.start,
            period.end,
            report.startBlock,
            report.endBlock,
            report.totals.liquidations.troveCount,
            format18(report.totals.liquidations.totalDebt),
            format18(report.totals.liquidations.totalColl),
            format18(report.totals.feesSentToFeeSharingCollector.zusdTotal),
            format18(report.totals.feesSentToFeeSharingCollector.rbtcTotal),
            report.totals.redemptions.count,
            format18(report.totals.redemptions.attemptedZusd),
            format18(report.totals.redemptions.actualZusd),
            format18(report.totals.redemptions.rbtcSent),
            format18(report.totals.redemptions.rbtcFee),
            report.totals.originationFees.chargedCount,
            format18(report.totals.originationFees.totalZusdFee),
            report.totals.rbtcRemovedViaDebtRepayment.txCount,
            format18(report.totals.rbtcRemovedViaDebtRepayment.totalRbtc),
            format18(report.totals.rbtcLockedInLinesOfCredit.startTotalRbtc),
            format18(report.totals.rbtcLockedInLinesOfCredit.endTotalRbtc),
        ];

        rows.push(row.map(csvEscape).join(","));
    }

    return `${rows.join("\n")}\n`;
};

const main = () => {
    const args = parseArgs();
    assertDateOnly(args.from, "--from");
    const to = args.to ?? getTodayUtcDate();
    assertDateOnly(to, "--to");

    const periods = buildPeriods(args.from, to);
    console.log(`Prepared ${periods.length} monthly period(s) from ${args.from} to ${to}.`);

    if (!args.reportsOnly) {
        for (const period of periods) {
            console.log(`\n=== ${period.label} ===`);
            runPeriodReport(args.network, period, args);
        }
    }

    const csvFile = args.csvFile ?? buildCsvPath(args.network, args.from, to);
    fs.mkdirSync(path.dirname(csvFile), { recursive: true });
    fs.writeFileSync(csvFile, buildCsvRows(periods, args.network));

    console.log(`\nCSV written to ${csvFile}`);
};

main();
