require("dotenv").config();

const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ========================================================
// 0. 配置
// ========================================================
const CIRCUITS_DIR = path.join(__dirname, "../circuits");
const WASM_PATH = path.join(CIRCUITS_DIR, "batch_capability_js/batch_capability.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "batch_final.zkey");
const VKEY_PATH = path.join(CIRCUITS_DIR, "batch_vkey.json");

const ROUNDS = Number(process.env.BENCHMARK_BATCH_ROUNDS || 10);
const FIXED_PROOF_SIZE = Number(process.env.BATCH_SIZE || 10);

// 实验一：固定证明规模下扫描真实交易数
const REAL_COUNTS = [1, 2, 4, 6, 8, 10];

// ========================================================
// 1. 工具函数
// ========================================================
function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
    return sortedArr[Math.max(0, Math.min(idx, sortedArr.length - 1))];
}

function summarize(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
    return {
        avg,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0
    };
}

function printSummaryLine(label, values) {
    const s = summarize(values);
    console.log(
        `${label.padEnd(22)} avg=${s.avg.toFixed(2)} ms | p50=${s.p50.toFixed(2)} ms | p95=${s.p95.toFixed(2)} ms | min=${s.min.toFixed(2)} | max=${s.max.toFixed(2)}`
    );
}

function ensureFileExists(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing file: ${filePath}`);
    }
}

function writeJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function writeCsv(filePath, rows) {
    if (!rows.length) {
        fs.writeFileSync(filePath, "");
        return;
    }

    const headers = Object.keys(rows[0]);
    const lines = [headers.join(",")];

    for (const row of rows) {
        const vals = headers.map((h) => {
            const raw = row[h] === undefined || row[h] === null ? "" : String(row[h]);
            if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
                return `"${raw.replace(/"/g, '""')}"`;
            }
            return raw;
        });
        lines.push(vals.join(","));
    }

    fs.writeFileSync(filePath, lines.join("\n"));
}

function randField() {
    // circom/snarkjs 输入用十进制字符串最稳
    return BigInt("0x" + crypto.randomBytes(31).toString("hex")).toString();
}

function makeRealItem(index) {
    // 这些字段只要满足电路里的单调约束即可
    // root >= child, childParentId == rootCapId, childIssuer == rootIssuer, childHolder == expectedProvider
    const rootIssuer = (1000n + BigInt(index)).toString();
    const childHolder = "55559"; // 任意固定非零 holder/provider
    const rootCapId = randField();
    const taskId = randField();
    const callId = randField();
    const reqHash = randField();
    const respHash = randField();

    return {
        rootIssuer,
        rootPerms: "8",
        rootBudget: "100",
        rootExpiry: "999999999",
        rootScopeHash: "777",
        rootCapId,

        childIssuer: rootIssuer,
        childHolder,
        childPerms: "1",
        childBudget: "8",
        childExpiry: "999999990",
        childScopeHash: "777",
        childParentId: rootCapId,
        childCapId: randField(),

        callId,
        taskId,
        reqHash,
        respHash,
        timestamp: String(1700000000 + index),
        expectedProvider: childHolder,
        isDummy: "0"
    };
}

function makeDummyItem() {
    return {
        rootIssuer: "0",
        rootPerms: "0",
        rootBudget: "0",
        rootExpiry: "0",
        rootScopeHash: "0",
        rootCapId: "0",

        childIssuer: "0",
        childHolder: "0",
        childPerms: "0",
        childBudget: "0",
        childExpiry: "0",
        childScopeHash: "0",
        childParentId: "0",
        childCapId: "0",

        callId: "0",
        taskId: "0",
        reqHash: "0",
        respHash: "0",
        timestamp: "0",
        expectedProvider: "0",
        isDummy: "1"
    };
}

function buildControlledInput(realCount, fixedSize) {
    const items = [];

    for (let i = 0; i < realCount; i++) {
        items.push(makeRealItem(i + 1));
    }
    for (let i = realCount; i < fixedSize; i++) {
        items.push(makeDummyItem());
    }

    return {
        rootIssuer: items.map((x) => x.rootIssuer),
        rootPerms: items.map((x) => x.rootPerms),
        rootBudget: items.map((x) => x.rootBudget),
        rootExpiry: items.map((x) => x.rootExpiry),
        rootScopeHash: items.map((x) => x.rootScopeHash),
        rootCapId: items.map((x) => x.rootCapId),

        childIssuer: items.map((x) => x.childIssuer),
        childHolder: items.map((x) => x.childHolder),
        childPerms: items.map((x) => x.childPerms),
        childBudget: items.map((x) => x.childBudget),
        childExpiry: items.map((x) => x.childExpiry),
        childScopeHash: items.map((x) => x.childScopeHash),
        childParentId: items.map((x) => x.childParentId),
        childCapId: items.map((x) => x.childCapId),

        callId: items.map((x) => x.callId),
        taskId: items.map((x) => x.taskId),
        reqHash: items.map((x) => x.reqHash),
        respHash: items.map((x) => x.respHash),
        timestamp: items.map((x) => x.timestamp),
        expectedProvider: items.map((x) => x.expectedProvider),
        isDummy: items.map((x) => x.isDummy)
    };
}

// ========================================================
// 2. 主程序
// ========================================================
async function main() {
    console.log("=========================================================");
    console.log("🧪 [Experiment-1] Dummy Padding & Fixed-Size Proving Scan");
    console.log("=========================================================\n");

    ensureFileExists(WASM_PATH);
    ensureFileExists(ZKEY_PATH);
    ensureFileExists(VKEY_PATH);

    const vKey = JSON.parse(fs.readFileSync(VKEY_PATH, "utf-8"));

    console.log(`Rounds per setting : ${ROUNDS}`);
    console.log(`Fixed proof size   : ${FIXED_PROOF_SIZE}`);
    console.log(`Scan real counts   : ${REAL_COUNTS.join(", ")}\n`);

    const outDir = path.join(__dirname, "../benchmark_results");
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const allResults = [];
    const csvRows = [];
    const rawRoundRows = [];

    for (const realCount of REAL_COUNTS) {
        if (realCount > FIXED_PROOF_SIZE) {
            throw new Error(`realCount=${realCount} exceeds fixed proof size=${FIXED_PROOF_SIZE}`);
        }

        const dummyCount = FIXED_PROOF_SIZE - realCount;
        const controlledInput = buildControlledInput(realCount, FIXED_PROOF_SIZE);

        const settingInputPath = path.join(
            outDir,
            `benchmark_batch_input_real_${realCount}.json`
        );
        writeJson(settingInputPath, controlledInput);

        console.log("---------------------------------------------------------");
        console.log(`🔹 realCount=${realCount}, dummyCount=${dummyCount}`);
        console.log("---------------------------------------------------------");

        const proveTimesAll = [];
        const verifyTimesAll = [];
        const proveTimesWarm = [];
        const verifyTimesWarm = [];

        for (let round = 1; round <= ROUNDS; round++) {
            const t1 = nowMs();
            const { proof, publicSignals } = await snarkjs.groth16.fullProve(
                controlledInput,
                WASM_PATH,
                ZKEY_PATH
            );
            const t2 = nowMs();
            const proveTime = t2 - t1;

            const t3 = nowMs();
            const ok = await snarkjs.groth16.verify(vKey, publicSignals, proof);
            const t4 = nowMs();
            const verifyTime = t4 - t3;

            if (!ok) {
                throw new Error(
                    `Verification failed at realCount=${realCount}, round=${round}`
                );
            }

            proveTimesAll.push(proveTime);
            verifyTimesAll.push(verifyTime);

            if (round > 1) {
                proveTimesWarm.push(proveTime);
                verifyTimesWarm.push(verifyTime);
            }

            rawRoundRows.push({
                realCount,
                dummyCount,
                round,
                isColdStart: round === 1 ? 1 : 0,
                proveMs: proveTime.toFixed(2),
                verifyMs: verifyTime.toFixed(2)
            });

            console.log(
                `Round ${round}/${ROUNDS}: prove=${proveTime.toFixed(2)} ms | verify=${verifyTime.toFixed(2)} ms${round === 1 ? "  [cold-start]" : ""}`
            );
        }

        const proveAllSummary = summarize(proveTimesAll);
        const verifyAllSummary = summarize(verifyTimesAll);
        const proveWarmSummary = summarize(proveTimesWarm);
        const verifyWarmSummary = summarize(verifyTimesWarm);

        console.log("\n📊 全部轮次（含冷启动）");
        printSummaryLine("prove_all", proveTimesAll);
        printSummaryLine("verify_all", verifyTimesAll);

        console.log("📊 稳态轮次（剔除第1轮）");
        printSummaryLine("prove_warm", proveTimesWarm);
        printSummaryLine("verify_warm", verifyTimesWarm);
        console.log("");

        const result = {
            realCount,
            dummyCount,
            fixedProofSize: FIXED_PROOF_SIZE,
            rounds: ROUNDS,
            allRounds: {
                prove: proveAllSummary,
                verify: verifyAllSummary
            },
            warmRounds: {
                prove: proveWarmSummary,
                verify: verifyWarmSummary
            },
            raw: {
                proveTimesAll,
                verifyTimesAll,
                proveTimesWarm,
                verifyTimesWarm
            }
        };

        allResults.push(result);

        csvRows.push({
            realCount,
            dummyCount,
            fixedProofSize: FIXED_PROOF_SIZE,
            rounds: ROUNDS,
            proveAvgMs_all: proveAllSummary.avg.toFixed(2),
            proveP50Ms_all: proveAllSummary.p50.toFixed(2),
            proveP95Ms_all: proveAllSummary.p95.toFixed(2),
            verifyAvgMs_all: verifyAllSummary.avg.toFixed(2),
            verifyP50Ms_all: verifyAllSummary.p50.toFixed(2),
            verifyP95Ms_all: verifyAllSummary.p95.toFixed(2),
            proveAvgMs_warm: proveWarmSummary.avg.toFixed(2),
            proveP50Ms_warm: proveWarmSummary.p50.toFixed(2),
            proveP95Ms_warm: proveWarmSummary.p95.toFixed(2),
            verifyAvgMs_warm: verifyWarmSummary.avg.toFixed(2),
            verifyP50Ms_warm: verifyWarmSummary.p50.toFixed(2),
            verifyP95Ms_warm: verifyWarmSummary.p95.toFixed(2)
        });
    }

    const summaryOutput = {
        generatedAt: new Date().toISOString(),
        config: {
            rounds: ROUNDS,
            fixedProofSize: FIXED_PROOF_SIZE,
            realCounts: REAL_COUNTS,
            wasmPath: WASM_PATH,
            zkeyPath: ZKEY_PATH,
            vkeyPath: VKEY_PATH
        },
        results: allResults
    };

    const jsonOutPath = path.join(outDir, "benchmark_dummy_padding_scan.json");
    const csvOutPath = path.join(outDir, "benchmark_dummy_padding_scan.csv");
    const rawCsvOutPath = path.join(outDir, "benchmark_dummy_padding_scan_raw_rounds.csv");

    writeJson(jsonOutPath, summaryOutput);
    writeCsv(csvOutPath, csvRows);
    writeCsv(rawCsvOutPath, rawRoundRows);

    console.log("=========================================================");
    console.log("📌 实验一核心结果（可直接进论文表格）");
    console.log("=========================================================");
    console.table(
        csvRows.map((r) => ({
            realCount: r.realCount,
            dummyCount: r.dummyCount,
            proveAvgMs_warm: r.proveAvgMs_warm,
            proveP50Ms_warm: r.proveP50Ms_warm,
            proveP95Ms_warm: r.proveP95Ms_warm
        }))
    );

    console.log(`✅ JSON 已写入: ${jsonOutPath}`);
    console.log(`✅ CSV 已写入 : ${csvOutPath}`);
    console.log(`✅ Raw CSV 已写入: ${rawCsvOutPath}`);
}

main().catch((err) => {
    console.error("❌ benchmark_batch_prover 运行失败:", err);
    process.exit(1);
});