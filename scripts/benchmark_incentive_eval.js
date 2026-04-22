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
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);

// 任务真正需要的调用数
const USEFUL_SUBCALLS = Number(process.env.BENCHMARK_USEFUL_SUBCALLS || 3);

if (!TRUSTED_ISSUER_PRIVATE_KEY) throw new Error("Missing TRUSTED_ISSUER_PRIVATE_KEY");
if (!BUYER_PRIVATE_KEY) throw new Error("Missing BUYER_PRIVATE_KEY");
if (!RAW_PROVIDER_ADDRESS) throw new Error("Missing PROVIDER_ADDRESS or GATEWAY_PROVIDER_ADDRESS");

// ========================================================
// 1. 工具函数
// ========================================================
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
    return ethers.utils.solidityKeccak256(["bytes32", "bytes"], [providerMsgHash, sigP]);
}

function buildCompletionMsgHash(cert) {
    return ethers.utils.solidityKeccak256(
        ["bytes32", "bytes32", "address", "uint256", "uint256", "bytes32", "bytes32"],
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
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    return data;
}

async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = data;
        throw err;
    }
    return data;
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

// ========================================================
// 2. 构造任务上下文
// ========================================================
async function createTaskContext(tag, issuerWallet, buyerWallet, providerAddress) {
    const requiredScope = DEFAULT_REQUIRED_SCOPE;
    const scopeHash = computeScopeHash(requiredScope);

    const taskId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "uint256", "string"],
            [buyerWallet.address, Date.now(), `incentive-${tag}`]
        )
    );

    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_CAP_EXPIRY_SECONDS;

    const taskMeta = {
        taskId,
        maxSubcalls: BATCH_SIZE,
        deadline
    };

    const rootCapability = {
        issuer: issuerWallet.address,
        holder: buyerWallet.address,
        perms: DEFAULT_REQUIRED_PERM,
        budget: DEFAULT_CAP_BUDGET.toString(),
        expiry: deadline,
        parentId: ethers.constants.HashZero,
        nonce: `${Date.now()}1`,
        scopeHash
    };

    const rootCapId = computeCapabilityId(rootCapability);
    const rootMsgHash = buildCapabilityMessageHash(rootCapability);
    const rootSignature = await issuerWallet.signMessage(ethers.utils.arrayify(rootMsgHash));

    return {
        taskId,
        taskMeta,
        rootCapability,
        rootCapId,
        rootSignature,
        requiredScope,
        buyerWallet,
        issuerWallet,
        providerAddress
    };
}

async function invokeAndConfirm(ctx, idx, operationName) {
    const childCapability = {
        issuer: ctx.issuerWallet.address,
        holder: ctx.providerAddress,
        perms: DEFAULT_REQUIRED_PERM,
        budget: PROVIDER_SERVICE_COST.toString(),
        expiry: ctx.rootCapability.expiry,
        parentId: ctx.rootCapId,
        nonce: `${Date.now()}${idx + 100}`,
        scopeHash: ctx.rootCapability.scopeHash
    };

    const childMsgHash = buildCapabilityMessageHash(childCapability);
    const childSignature = await ctx.buyerWallet.signMessage(ethers.utils.arrayify(childMsgHash));

    const invokeResp = await postJson(`${GATEWAY_BASE_URL}/invoke`, {
        caller: ctx.buyerWallet.address,
        requestPayload: {
            operationName,
            requiredPerm: DEFAULT_REQUIRED_PERM,
            requiredScope: ctx.requiredScope
        },
        taskMeta: ctx.taskMeta,
        rootCapability: ctx.rootCapability,
        rootSignature: ctx.rootSignature,
        childCapability,
        childSignature
    });

    const providerMsgHash = buildProviderMsgHash({
        callId: invokeResp.callId,
        rootCapId: invokeResp.rootCapId,
        childCapId: invokeResp.childCapId,
        payer: ctx.rootCapability.issuer,
        caller: ctx.buyerWallet.address,
        orchestrator: ctx.buyerWallet.address,
        provider: invokeResp.provider,
        providerAmount: invokeResp.providerAmount,
        orchestratorFee: invokeResp.orchestratorFee,
        timestamp: invokeResp.timestamp,
        reqHash: invokeResp.reqHash,
        respHash: invokeResp.respHash
    });

    const callerMsgHash = buildCallerMsgHash(providerMsgHash, invokeResp.sigP);
    const sigC = await ctx.buyerWallet.signMessage(ethers.utils.arrayify(callerMsgHash));

    await postJson(`${GATEWAY_BASE_URL}/confirmReceipt`, {
        callId: invokeResp.callId,
        caller: ctx.buyerWallet.address,
        sigC
    });

    return invokeResp;
}

async function closeTask(ctx, collectedResults, completionReason) {
    const taskStateResp = await getJson(`${GATEWAY_BASE_URL}/taskState/${ctx.taskId}`);
    const taskState = taskStateResp.taskState;

    const finalResultText = collectedResults.join(" | ");
    const finalResultHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(finalResultText));
    const completionReasonHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(completionReason));

    const completionCert = {
        taskId: ctx.taskId,
        rootCapId: ctx.rootCapId,
        caller: ctx.buyerWallet.address,
        spentBudget: taskState.spentBudget,
        usedSubcalls: taskState.usedSubcalls,
        finalResultHash,
        completionReasonHash
    };

    const completionMsgHash = buildCompletionMsgHash(completionCert);
    const completionSignature = await ctx.buyerWallet.signMessage(
        ethers.utils.arrayify(completionMsgHash)
    );

    await postJson(`${GATEWAY_BASE_URL}/completeTask`, {
        taskId: ctx.taskId,
        caller: ctx.buyerWallet.address,
        finalResultHash,
        completionReason,
        completionSignature
    });
}

async function tryInvokeAfterClose(ctx) {
    try {
        await invokeAndConfirm(ctx, 9999, "post-close illegal invoke");
        return { rejected: false, message: "" };
    } catch (err) {
        return {
            rejected: true,
            message: err.message || ""
        };
    }
}

function formatStrategyResult(label, taskState, postClose) {
    const usefulCalls = USEFUL_SUBCALLS;
    const totalCalls = Number(taskState.usedSubcalls);
    const extraCalls = Math.max(0, totalCalls - usefulCalls);

    const totalSpend = Number(taskState.spentBudget);
    const effectiveSpend = usefulCalls * (PROVIDER_SERVICE_COST + ORCHESTRATOR_FEE);
    const waste = Math.max(0, totalSpend - effectiveSpend);

    return {
        strategy: label,
        totalCalls,
        effectiveCalls: usefulCalls,
        extraCalls,
        totalSpend,
        effectiveSpend,
        waste,
        wasteRate: totalSpend > 0 ? waste / totalSpend : 0,
        providerRevenue: totalCalls * PROVIDER_SERVICE_COST,
        orchestratorRevenue: totalCalls * ORCHESTRATOR_FEE,
        rejectAfterClose: postClose.rejected,
        rejectMessage: postClose.message
    };
}

// ========================================================
// 3. 两种策略
// ========================================================
async function runHonestStrategy(issuerWallet, buyerWallet, providerAddress) {
    const ctx = await createTaskContext("honest", issuerWallet, buyerWallet, providerAddress);
    const collectedResults = [];

    for (let i = 0; i < USEFUL_SUBCALLS; i++) {
        const resp = await invokeAndConfirm(ctx, i, `honest useful subcall ${i + 1}`);
        collectedResults.push(resp.data);
    }

    await closeTask(
        ctx,
        collectedResults,
        "Honest strategy closes immediately after goal reached"
    );

    const taskStateResp = await getJson(`${GATEWAY_BASE_URL}/taskState/${ctx.taskId}`);
    const postClose = await tryInvokeAfterClose(ctx);

    return formatStrategyResult("Honest-Orchestrator", taskStateResp.taskState, postClose);
}

async function runGreedyStrategy(issuerWallet, buyerWallet, providerAddress) {
    const ctx = await createTaskContext("greedy", issuerWallet, buyerWallet, providerAddress);
    const collectedResults = [];

    for (let i = 0; i < USEFUL_SUBCALLS; i++) {
        const resp = await invokeAndConfirm(ctx, i, `greedy useful subcall ${i + 1}`);
        collectedResults.push(resp.data);
    }

    for (let i = USEFUL_SUBCALLS; i < BATCH_SIZE; i++) {
        try {
            const resp = await invokeAndConfirm(ctx, i, `greedy extra subcall ${i + 1}`);
            collectedResults.push(resp.data);
        } catch (err) {
            break;
        }
    }

    await closeTask(
        ctx,
        collectedResults,
        "Greedy strategy closes only after exhausting budget/window"
    );

    const taskStateResp = await getJson(`${GATEWAY_BASE_URL}/taskState/${ctx.taskId}`);
    const postClose = await tryInvokeAfterClose(ctx);

    return formatStrategyResult("Greedy-Orchestrator", taskStateResp.taskState, postClose);
}

// ========================================================
// 4. 主程序
// ========================================================
async function main() {
    console.log("=========================================================");
    console.log("🧪 [Benchmark] Incentive Evaluation");
    console.log("=========================================================\n");

    const issuerWallet = new ethers.Wallet(TRUSTED_ISSUER_PRIVATE_KEY);
    const buyerWallet = new ethers.Wallet(
        BUYER_PRIVATE_KEY,
        new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL)
    );
    const providerAddress = ethers.utils.getAddress(RAW_PROVIDER_ADDRESS);

    console.log(`Useful subcalls target  : ${USEFUL_SUBCALLS}`);
    console.log(`Batch size/maxSubcalls  : ${BATCH_SIZE}`);
    console.log(`Provider fee            : ${PROVIDER_SERVICE_COST}`);
    console.log(`Orchestrator fee        : ${ORCHESTRATOR_FEE}`);
    console.log(`Per-call total spend    : ${PROVIDER_SERVICE_COST + ORCHESTRATOR_FEE}`);
    console.log(`Task budget             : ${DEFAULT_CAP_BUDGET}\n`);

    const honest = await runHonestStrategy(issuerWallet, buyerWallet, providerAddress);
    await sleep(2000);
    const greedy = await runGreedyStrategy(issuerWallet, buyerWallet, providerAddress);

    const rows = [honest, greedy];

    const result = {
        generatedAt: new Date().toISOString(),
        config: {
            usefulSubcalls: USEFUL_SUBCALLS,
            batchSize: BATCH_SIZE,
            providerServiceCost: PROVIDER_SERVICE_COST,
            orchestratorFee: ORCHESTRATOR_FEE,
            perCallTotalSpend: PROVIDER_SERVICE_COST + ORCHESTRATOR_FEE,
            defaultCapBudget: DEFAULT_CAP_BUDGET
        },
        rows,
        comparison: {
            totalSpendDelta: greedy.totalSpend - honest.totalSpend,
            wasteDelta: greedy.waste - honest.waste,
            wasteRateDelta: greedy.wasteRate - honest.wasteRate,
            providerRevenueDelta: greedy.providerRevenue - honest.providerRevenue,
            orchestratorRevenueDelta: greedy.orchestratorRevenue - honest.orchestratorRevenue
        }
    };

    const outDir = path.join(__dirname, "../benchmark_results");
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const jsonPath = path.join(outDir, "benchmark_incentive_eval_results.json");
    const csvPath = path.join(outDir, "benchmark_incentive_eval_results.csv");

    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    writeCsv(csvPath, rows);

    console.log("=========================================================");
    console.log("📊 Honest vs Greedy 收益矩阵");
    console.log("=========================================================");
    console.table(
        rows.map((r) => ({
            strategy: r.strategy,
            totalCalls: r.totalCalls,
            effectiveCalls: r.effectiveCalls,
            extraCalls: r.extraCalls,
            totalSpend: r.totalSpend,
            effectiveSpend: r.effectiveSpend,
            waste: r.waste,
            wasteRate: r.wasteRate,
            providerRevenue: r.providerRevenue,
            orchestratorRevenue: r.orchestratorRevenue
        }))
    );

    console.log(`✅ JSON 已写入: ${jsonPath}`);
    console.log(`✅ CSV 已写入 : ${csvPath}`);
}

main().catch((err) => {
    console.error("❌ benchmark_incentive_eval 运行失败:", err);
    process.exit(1);
});