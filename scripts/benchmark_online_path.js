require("dotenv").config();

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// ========================================================
// 0. 配置
// ========================================================
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:3000";
const TRUSTED_ISSUER_PRIVATE_KEY = process.env.TRUSTED_ISSUER_PRIVATE_KEY || "";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";
const SEPOLIA_RPC_URL =
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

const DEFAULT_REQUIRED_SCOPE = process.env.DEFAULT_REQUIRED_SCOPE || "PUBLIC_MARKET_DATA";
const DEFAULT_REQUIRED_PERM = Number(process.env.DEFAULT_REQUIRED_PERM || 1);
const DEFAULT_CAP_BUDGET = Number(process.env.DEFAULT_CAP_BUDGET || 100);
const DEFAULT_CAP_EXPIRY_SECONDS = Number(process.env.DEFAULT_CAP_EXPIRY_SECONDS || 86400);

const RAW_PROVIDER_ADDRESS =
    process.env.PROVIDER_ADDRESS || process.env.GATEWAY_PROVIDER_ADDRESS || "";

const PROVIDER_SERVICE_COST = Number(process.env.PROVIDER_SERVICE_COST || 8);
const ORCHESTRATOR_FEE = Number(process.env.ORCHESTRATOR_FEE || 2);

// 建议：无卡先 5 轮；拿到卡后 10~20 轮
const ROUNDS = Number(process.env.BENCHMARK_ROUNDS || 5);
// 6.2 在线关键路径建议每轮只做 1 次 subcall
const SUBCALLS_PER_ROUND = Number(process.env.BENCHMARK_SUBCALLS_PER_ROUND || 1);
// 任务逻辑上限仍保留默认 10
const MAX_SUBCALLS = Number(process.env.BENCHMARK_MAX_SUBCALLS || 10);

// 是否剔除第 1 轮冷启动做正式统计
const EXCLUDE_FIRST_ROUND = String(
    process.env.BENCHMARK_EXCLUDE_FIRST_ROUND || "true"
).toLowerCase() === "true";

if (!TRUSTED_ISSUER_PRIVATE_KEY) {
    throw new Error("Missing TRUSTED_ISSUER_PRIVATE_KEY in .env");
}
if (!BUYER_PRIVATE_KEY) {
    throw new Error("Missing BUYER_PRIVATE_KEY in .env");
}
if (!RAW_PROVIDER_ADDRESS) {
    throw new Error("Missing PROVIDER_ADDRESS (or GATEWAY_PROVIDER_ADDRESS) in .env");
}

// ========================================================
// 1. 工具函数
// ========================================================
function nowMs() {
    return Number(process.hrtime.bigint()) / 1e6;
}

function computeScopeHash(requiredScope) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(requiredScope));
}

function buildCapabilityMessageHash(capability) {
    return ethers.utils.solidityKeccak256(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
        [
            capability.issuer,
            capability.holder,
            capability.perms,
            capability.budget,
            capability.expiry,
            capability.parentId,
            capability.nonce,
            capability.scopeHash
        ]
    );
}

function computeCapabilityId(capability) {
    return ethers.utils.solidityKeccak256(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
        [
            capability.issuer,
            capability.holder,
            capability.perms,
            capability.budget,
            capability.expiry,
            capability.parentId,
            capability.nonce,
            capability.scopeHash
        ]
    );
}

function buildProviderMsgHash(receiptLike) {
    return ethers.utils.solidityKeccak256(
        [
            "bytes32",
            "bytes32",
            "bytes32",
            "address",
            "address",
            "address",
            "address",
            "uint256",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32"
        ],
        [
            receiptLike.callId,
            receiptLike.rootCapId,
            receiptLike.childCapId,
            receiptLike.payer,
            receiptLike.caller,
            receiptLike.orchestrator,
            receiptLike.provider,
            receiptLike.providerAmount,
            receiptLike.orchestratorFee,
            receiptLike.timestamp,
            receiptLike.reqHash,
            receiptLike.respHash
        ]
    );
}

function buildCallerMsgHash(providerMsgHash, sigP) {
    return ethers.utils.solidityKeccak256(
        ["bytes32", "bytes"],
        [providerMsgHash, sigP]
    );
}

function buildCompletionMsgHash(cert) {
    return ethers.utils.solidityKeccak256(
        [
            "bytes32",
            "bytes32",
            "address",
            "uint256",
            "uint256",
            "bytes32",
            "bytes32"
        ],
        [
            cert.taskId,
            cert.rootCapId,
            cert.caller,
            cert.spentBudget,
            cert.usedSubcalls,
            cert.finalResultHash,
            cert.completionReasonHash
        ]
    );
}

async function postJson(url, body) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
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

function printSummary(name, values) {
    const s = summarize(values);
    console.log(
        `${name.padEnd(22)} avg=${s.avg.toFixed(2)} ms | p50=${s.p50.toFixed(2)} ms | p95=${s.p95.toFixed(2)} ms | min=${s.min.toFixed(2)} | max=${s.max.toFixed(2)}`
    );
}

// ========================================================
// 2. 单轮实验（严格对齐论文 6.2）
// ========================================================
// T_exec  = invoke 的端到端在线请求时延
// T_conf  = 本地哈希构造 + buyer 本地 ECDSA 二签 + confirmReceipt 请求
// T_close = taskState 查询 + Completion Certificate 构造 + 本地签名 + completeTask 请求
async function runOneRound(roundId, issuerWallet, buyerWallet, providerAddress) {
    const requiredScope = DEFAULT_REQUIRED_SCOPE;
    const scopeHash = computeScopeHash(requiredScope);

    const taskId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "uint256", "string"],
            [
                buyerWallet.address,
                Date.now(),
                `benchmark-online-path-round-${roundId}`
            ]
        )
    );

    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_CAP_EXPIRY_SECONDS;

    const taskMeta = {
        taskId,
        maxSubcalls: MAX_SUBCALLS,
        deadline
    };

    const rootCapability = {
        issuer: issuerWallet.address,
        holder: buyerWallet.address,
        perms: DEFAULT_REQUIRED_PERM,
        budget: DEFAULT_CAP_BUDGET.toString(),
        expiry: deadline,
        parentId: ethers.constants.HashZero,
        nonce: (1000000 + roundId).toString(),
        scopeHash
    };

    const rootCapId = computeCapabilityId(rootCapability);
    const rootMsgHash = buildCapabilityMessageHash(rootCapability);
    const rootSignature = await issuerWallet.signMessage(
        ethers.utils.arrayify(rootMsgHash)
    );

    const fixedPrompt = `Benchmark round ${roundId}: fetch concise public market insight`;

    const invokeTimes = [];
    const confirmTimes = [];
    const collectedResults = [];

    let finalTaskState = null;

    for (let i = 1; i <= SUBCALLS_PER_ROUND; i++) {
        const childCapability = {
            issuer: issuerWallet.address,
            holder: providerAddress,
            perms: DEFAULT_REQUIRED_PERM,
            budget: PROVIDER_SERVICE_COST.toString(),
            expiry: rootCapability.expiry,
            parentId: rootCapId,
            nonce: (2000000 + roundId * 100 + i).toString(),
            scopeHash
        };

        const childMsgHash = buildCapabilityMessageHash(childCapability);
        const childSignature = await buyerWallet.signMessage(
            ethers.utils.arrayify(childMsgHash)
        );

        const requestPayload = {
            operationName: `${fixedPrompt} [subcall=${i}]`,
            requiredPerm: DEFAULT_REQUIRED_PERM,
            requiredScope
        };

        // ----------------------------------------------------
        // T_exec
        // ----------------------------------------------------
        const tExecStart = nowMs();
        const invokeResp = await postJson(`${GATEWAY_BASE_URL}/invoke`, {
            caller: buyerWallet.address,
            requestPayload,
            taskMeta,
            rootCapability,
            rootSignature,
            childCapability,
            childSignature
        });
        const tExecEnd = nowMs();
        const tExec = tExecEnd - tExecStart;
        invokeTimes.push(tExec);

        collectedResults.push(invokeResp.data);

        // ----------------------------------------------------
        // T_conf
        // ----------------------------------------------------
        const tConfStart = nowMs();

        const providerMsgHash = buildProviderMsgHash({
            callId: invokeResp.callId,
            rootCapId: invokeResp.rootCapId,
            childCapId: invokeResp.childCapId,
            payer: rootCapability.issuer,
            caller: buyerWallet.address,
            orchestrator: buyerWallet.address,
            provider: invokeResp.provider,
            providerAmount: invokeResp.providerAmount,
            orchestratorFee: invokeResp.orchestratorFee,
            timestamp: invokeResp.timestamp,
            reqHash: invokeResp.reqHash,
            respHash: invokeResp.respHash
        });

        const callerMsgHash = buildCallerMsgHash(providerMsgHash, invokeResp.sigP);
        const sigC = await buyerWallet.signMessage(ethers.utils.arrayify(callerMsgHash));

        await postJson(`${GATEWAY_BASE_URL}/confirmReceipt`, {
            callId: invokeResp.callId,
            caller: buyerWallet.address,
            sigC
        });

        const tConfEnd = nowMs();
        const tConf = tConfEnd - tConfStart;
        confirmTimes.push(tConf);
    }

    // --------------------------------------------------------
    // T_close
    // --------------------------------------------------------
    const tCloseStart = nowMs();

    const taskStateResp = await getJson(`${GATEWAY_BASE_URL}/taskState/${taskId}`);
    finalTaskState = taskStateResp.taskState;

    const finalResultText = collectedResults.join(" | ");
    const finalResultHash = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(finalResultText)
    );

    const completionReason = "Benchmark task completed";
    const completionReasonHash = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(completionReason)
    );

    const completionCert = {
        taskId,
        rootCapId,
        caller: buyerWallet.address,
        spentBudget: finalTaskState.spentBudget,
        usedSubcalls: finalTaskState.usedSubcalls,
        finalResultHash,
        completionReasonHash
    };

    const completionMsgHash = buildCompletionMsgHash(completionCert);
    const completionSignature = await buyerWallet.signMessage(
        ethers.utils.arrayify(completionMsgHash)
    );

    await postJson(`${GATEWAY_BASE_URL}/completeTask`, {
        taskId,
        caller: buyerWallet.address,
        finalResultHash,
        completionReason,
        completionSignature
    });

    const tCloseEnd = nowMs();
    const tClose = tCloseEnd - tCloseStart;

    const invokeAvg = summarize(invokeTimes).avg;
    const confirmAvg = summarize(confirmTimes).avg;

    const protocolOverhead = confirmAvg + tClose;
    const onlineTotal = invokeAvg + confirmAvg + tClose;

    return {
        invokeTimes,
        confirmTimes,
        closeTime: tClose,
        protocolOverhead,
        onlineTotal,
        usedSubcalls: finalTaskState.usedSubcalls,
        spentBudget: finalTaskState.spentBudget
    };
}

// ========================================================
// 3. 主程序
// ========================================================
async function main() {
    console.log("=========================================================");
    console.log("📏 [Benchmark] zk-CrossAgent 在线关键路径时延测试（严格版）");
    console.log("=========================================================\n");

    const issuerWallet = new ethers.Wallet(TRUSTED_ISSUER_PRIVATE_KEY);
    const buyerWallet = new ethers.Wallet(
        BUYER_PRIVATE_KEY,
        new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL)
    );
    const providerAddress = ethers.utils.getAddress(RAW_PROVIDER_ADDRESS);

    console.log(`Gateway URL               : ${GATEWAY_BASE_URL}`);
    console.log(`Rounds                    : ${ROUNDS}`);
    console.log(`Subcalls per round        : ${SUBCALLS_PER_ROUND}`);
    console.log(`Task maxSubcalls          : ${MAX_SUBCALLS}`);
    console.log(`Provider cost             : ${PROVIDER_SERVICE_COST}`);
    console.log(`Orchestrator fee          : ${ORCHESTRATOR_FEE}`);
    console.log(`Default task budget       : ${DEFAULT_CAP_BUDGET}`);
    console.log(`Exclude first round       : ${EXCLUDE_FIRST_ROUND}`);
    console.log("");

    const allInvoke = [];
    const allConfirm = [];
    const allClose = [];
    const allProtocolOverhead = [];
    const allOnlineTotal = [];

    const warmInvoke = [];
    const warmConfirm = [];
    const warmClose = [];
    const warmProtocolOverhead = [];
    const warmOnlineTotal = [];

    const perRoundStats = [];

    for (let r = 1; r <= ROUNDS; r++) {
        console.log(`\n---------------- Round ${r}/${ROUNDS} ----------------`);

        const result = await runOneRound(r, issuerWallet, buyerWallet, providerAddress);

        allInvoke.push(...result.invokeTimes);
        allConfirm.push(...result.confirmTimes);
        allClose.push(result.closeTime);
        allProtocolOverhead.push(result.protocolOverhead);
        allOnlineTotal.push(result.onlineTotal);

        if (!EXCLUDE_FIRST_ROUND || r >= 2) {
            warmInvoke.push(...result.invokeTimes);
            warmConfirm.push(...result.confirmTimes);
            warmClose.push(result.closeTime);
            warmProtocolOverhead.push(result.protocolOverhead);
            warmOnlineTotal.push(result.onlineTotal);
        }

        perRoundStats.push({
            round: r,
            usedSubcalls: result.usedSubcalls,
            spentBudget: result.spentBudget,
            invokeAvg: summarize(result.invokeTimes).avg,
            confirmAvg: summarize(result.confirmTimes).avg,
            closeTime: result.closeTime,
            protocolOverhead: result.protocolOverhead,
            onlineTotal: result.onlineTotal,
            includedInWarmStats: !EXCLUDE_FIRST_ROUND || r >= 2
        });

        console.log(`usedSubcalls=${result.usedSubcalls}, spentBudget=${result.spentBudget}`);
        console.log(`online total = ${result.onlineTotal.toFixed(2)} ms`);
    }

    console.log("\n=========================================================");
    console.log(
        EXCLUDE_FIRST_ROUND
            ? "📊 在线关键路径时延汇总（严格口径，已剔除第1轮冷启动）"
            : "📊 在线关键路径时延汇总（严格口径，全轮次）"
    );
    console.log("=========================================================");
    printSummary("invoke (T_exec)", warmInvoke);
    printSummary("confirm (T_conf)", warmConfirm);
    printSummary("close (T_close)", warmClose);
    printSummary("protocol_overhead", warmProtocolOverhead);
    printSummary("online_total", warmOnlineTotal);

    const output = {
        generatedAt: new Date().toISOString(),
        config: {
            gatewayBaseUrl: GATEWAY_BASE_URL,
            rounds: ROUNDS,
            subcallsPerRound: SUBCALLS_PER_ROUND,
            taskMaxSubcalls: MAX_SUBCALLS,
            providerServiceCost: PROVIDER_SERVICE_COST,
            orchestratorFee: ORCHESTRATOR_FEE,
            defaultCapBudget: DEFAULT_CAP_BUDGET,
            excludeFirstRound: EXCLUDE_FIRST_ROUND
        },
        definition: {
            tExec: "End-to-end invoke latency on the online path",
            tConf: "Local hash construction + local ECDSA buyer signature + confirmReceipt request",
            tClose: "taskState query + Completion Certificate construction + local signature + completeTask request",
            protocolOverhead: "T_conf + T_close",
            onlineTotal: "T_exec + T_conf + T_close"
        },
        summary: {
            allRounds: {
                invoke: summarize(allInvoke),
                confirm: summarize(allConfirm),
                close: summarize(allClose),
                protocolOverhead: summarize(allProtocolOverhead),
                onlineTotal: summarize(allOnlineTotal)
            },
            warmOnly: {
                invoke: summarize(warmInvoke),
                confirm: summarize(warmConfirm),
                close: summarize(warmClose),
                protocolOverhead: summarize(warmProtocolOverhead),
                onlineTotal: summarize(warmOnlineTotal)
            }
        },
        perRoundStats
    };

    const outDir = path.join(__dirname, "../benchmark_results");
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const outPath = path.join(outDir, "benchmark_online_path_results_strict.json");
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    console.log(`\n✅ 结果已写入: ${outPath}`);
}

main().catch((err) => {
    console.error("❌ benchmark_online_path_strict 运行失败:", err);
    process.exit(1);
});