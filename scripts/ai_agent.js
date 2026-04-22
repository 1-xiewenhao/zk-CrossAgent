require("dotenv").config();

const { ethers } = require("hardhat");
const OpenAI = require("openai");

// ========================================================
// 0. 配置区
// ========================================================
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:3000";
const TRUSTED_ISSUER_PRIVATE_KEY = process.env.TRUSTED_ISSUER_PRIVATE_KEY || "";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";

const DEFAULT_REQUIRED_SCOPE = process.env.DEFAULT_REQUIRED_SCOPE || "PUBLIC_MARKET_DATA";
const DEFAULT_REQUIRED_PERM = Number(process.env.DEFAULT_REQUIRED_PERM || 1);
const DEFAULT_CAP_BUDGET = Number(process.env.DEFAULT_CAP_BUDGET || 50);
const DEFAULT_CAP_EXPIRY_SECONDS = Number(process.env.DEFAULT_CAP_EXPIRY_SECONDS || 86400);

const RAW_PROVIDER_ADDRESS =
    process.env.PROVIDER_ADDRESS || process.env.GATEWAY_PROVIDER_ADDRESS || "";

if (!RAW_PROVIDER_ADDRESS) {
    throw new Error("Missing PROVIDER_ADDRESS (or GATEWAY_PROVIDER_ADDRESS) in .env");
}

const PROVIDER_ADDRESS = ethers.utils.getAddress(RAW_PROVIDER_ADDRESS);

const PROVIDER_SERVICE_COST = Number(process.env.PROVIDER_SERVICE_COST || 8);
const ORCHESTRATOR_FEE = Number(process.env.ORCHESTRATOR_FEE || 2);

const SEPOLIA_RPC_URL =
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

if (!DEEPSEEK_API_KEY) {
    console.warn("⚠️ 未配置 DEEPSEEK_API_KEY。");
}
if (!TRUSTED_ISSUER_PRIVATE_KEY) {
    console.warn("⚠️ 未配置 TRUSTED_ISSUER_PRIVATE_KEY。");
}
if (!BUYER_PRIVATE_KEY) {
    console.warn("⚠️ 未配置 BUYER_PRIVATE_KEY。");
}

const openai = new OpenAI({
    baseURL: "https://api.deepseek.com",
    apiKey: DEEPSEEK_API_KEY
});

// ========================================================
// 1. 工具函数
// ========================================================
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
            "bytes32", // callId
            "bytes32", // rootCapId
            "bytes32", // childCapId
            "address", // payer
            "address", // caller
            "address", // orchestrator
            "address", // provider
            "uint256", // providerAmount
            "uint256", // orchestratorFee
            "uint256", // timestamp
            "bytes32", // reqHash
            "bytes32"  // respHash
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
            "bytes32", // taskId
            "bytes32", // rootCapId
            "address", // caller
            "uint256", // spentBudget
            "uint256", // usedSubcalls
            "bytes32", // finalResultHash
            "bytes32"  // completionReasonHash
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

    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

async function getJson(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
}

// ========================================================
// 2. 主流程
// ========================================================
async function main() {
    console.log("=========================================================");
    console.log("💼 DeepSeek Buyer Agent（route-B + Completion Certificate 版）");
    console.log("=========================================================\n");

    const issuerWallet = new ethers.Wallet(TRUSTED_ISSUER_PRIVATE_KEY);
    const buyerWallet = new ethers.Wallet(
        BUYER_PRIVATE_KEY,
        new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL)
    );

    console.log(`🛡️ Trusted Issuer 地址: ${issuerWallet.address}`);
    console.log(`🧾 Buyer 地址: ${buyerWallet.address}`);
    console.log(`🏷️ Provider/Gateway 地址: ${PROVIDER_ADDRESS}`);
    console.log(`🌐 Gateway 地址: ${GATEWAY_BASE_URL}\n`);

    const requiredScope = DEFAULT_REQUIRED_SCOPE;
    const scopeHash = computeScopeHash(requiredScope);

    // =====================================================
    // 任务级元数据：这是 Completion Certificate 的基础
    // =====================================================
    const taskId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "uint256", "string"],
            [buyerWallet.address, Date.now(), "DeepSeek multi-step market research task"]
        )
    );

    const taskMeta = {
        taskId,
        maxSubcalls: 10,
        deadline: Math.floor(Date.now() / 1000) + DEFAULT_CAP_EXPIRY_SECONDS
    };

    console.log(`📌 本次任务 taskId: ${taskId}`);
    console.log(`📌 maxSubcalls: ${taskMeta.maxSubcalls}`);
    console.log(`📌 deadline: ${taskMeta.deadline}\n`);

    // ------------------------------------------------
    // Step 1: issuer 给 buyer 签 root capability（任务总预算）
    // ------------------------------------------------
    const rootCapability = {
        issuer: issuerWallet.address,
        holder: buyerWallet.address,
        perms: DEFAULT_REQUIRED_PERM,
        budget: DEFAULT_CAP_BUDGET.toString(),
        expiry: taskMeta.deadline,
        parentId: ethers.constants.HashZero,
        nonce: "1",
        scopeHash
    };

    const rootCapId = computeCapabilityId(rootCapability);
    const rootMsgHash = buildCapabilityMessageHash(rootCapability);
    const rootSignature = await issuerWallet.signMessage(
        ethers.utils.arrayify(rootMsgHash)
    );

    console.log("🧾 已生成 root capability:");
    console.log(`   - rootCapId: ${rootCapId}`);
    console.log(`   - issuer: ${rootCapability.issuer}`);
    console.log(`   - holder(buyer): ${rootCapability.holder}`);
    console.log(`   - taskBudget: ${rootCapability.budget}`);

    const targetAssets = [
        "英伟达(NVDA)最新公开财报",
        "比特币(BTC)链上活跃度",
        "苹果(AAPL)头显销量分析",
        "特斯拉(TSLA)降价后的市场预期",
        "微软(MSFT)的AI业务营收概况",
        "以太坊(ETH)近一周的Gas消耗趋势",
        "AMD(超威半导体)的公开技术路线图",
        "SpaceX商业航天发射频率统计",
        "宁德时代(固态电池)的行业公开研报",
        "OpenAI近期公开投资动态"
    ];

    const collectedResults = [];

    for (let i = 1; i <= taskMeta.maxSubcalls; i++) {
        console.log(`\n================== [第 ${i}/${taskMeta.maxSubcalls} 笔交易] ==================`);

        // Step 2: DeepSeek 生成购买意图
        console.log("🧠 DeepSeek 正在构思合规购买意图...");
        const asset = targetAssets[i - 1];

        const aiResponse = await openai.chat.completions.create({
            model: "deepseek-chat",
            messages: [{
                role: "user",
                content: `你是一个专业的量化基金经理。请用一句话生成一个向外部数据商购买分析报告的请求。
购买目标：${asset}。
要求：必须基于“公开市场数据”。绝对不能出现“机密”、“未公开”、“内幕”等违规词汇。语气要专业简练。`
            }]
        });

        const prompt = aiResponse.choices[0].message.content.replace(/[\r\n]/g, "");
        console.log(`🗣️ DeepSeek 说: "${prompt}"`);

        // ------------------------------------------------
        // Step 3: buyer 派生 child capability 给 provider/gateway
        // 每笔子调用一个 child capability
        // ------------------------------------------------
        const childCapability = {
            issuer: issuerWallet.address,
            holder: PROVIDER_ADDRESS,
            perms: DEFAULT_REQUIRED_PERM,
            budget: PROVIDER_SERVICE_COST.toString(),
            expiry: rootCapability.expiry,
            parentId: rootCapId,
            nonce: (100000 + i).toString(),
            scopeHash
        };

        const childCapId = computeCapabilityId(childCapability);
        const childMsgHash = buildCapabilityMessageHash(childCapability);
        const childSignature = await buyerWallet.signMessage(
            ethers.utils.arrayify(childMsgHash)
        );

        console.log("🧾 已生成 child capability:");
        console.log(`   - childCapId: ${childCapId}`);
        console.log(`   - parentId(rootCapId): ${childCapability.parentId}`);
        console.log(`   - holder(provider): ${childCapability.holder}`);
        console.log(`   - childBudget(providerAmount): ${childCapability.budget}`);

        // ------------------------------------------------
        // Step 4: buyer 调 gateway
        // ------------------------------------------------
        console.log("🌐 正在向 Gateway 发起 invoke 请求...");
        const invokeResp = await postJson(`${GATEWAY_BASE_URL}/invoke`, {
            caller: buyerWallet.address,
            requestPayload: {
                operationName: prompt,
                requiredPerm: DEFAULT_REQUIRED_PERM,
                requiredScope
            },
            taskMeta,
            rootCapability,
            rootSignature,
            childCapability,
            childSignature
        });

        console.log(`📥 收到 Gateway 发来的数据: "${invokeResp.data}"`);
        console.log(`   - taskId: ${invokeResp.taskId}`);
        console.log(`   - callId: ${invokeResp.callId}`);
        console.log(`   - rootCapId: ${invokeResp.rootCapId}`);
        console.log(`   - childCapId: ${invokeResp.childCapId}`);
        console.log(`   - provider: ${invokeResp.provider}`);
        console.log(`   - providerAmount: ${invokeResp.providerAmount}`);
        console.log(`   - orchestratorFee: ${invokeResp.orchestratorFee}`);
        console.log(`   - totalAmount: ${invokeResp.totalAmount}`);

        collectedResults.push(invokeResp.data);

        // ------------------------------------------------
        // Step 5: buyer 对新版 receipt 补 sigC
        // ------------------------------------------------
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

        const sigC = await buyerWallet.signMessage(
            ethers.utils.arrayify(callerMsgHash)
        );

        console.log("✍️ Buyer 已完成新版 receipt 二次签名 (sigC)");

        // ------------------------------------------------
        // Step 6: 回传给 gateway
        // ------------------------------------------------
        console.log("📨 正在向 Gateway 提交 confirmReceipt...");
        const confirmResp = await postJson(`${GATEWAY_BASE_URL}/confirmReceipt`, {
            callId: invokeResp.callId,
            caller: buyerWallet.address,
            sigC
        });

        console.log(`✅ Receipt 已确认: ${confirmResp.message}`);
        console.log(`   - 当前批处理队列长度: ${confirmResp.queueLength}`);
    }

    // =====================================================
    // Step 7: 查询 taskState，生成 Completion Certificate
    // =====================================================
    console.log("\n📡 正在查询任务状态并生成 Completion Certificate...");
    const taskStateResp = await getJson(`${GATEWAY_BASE_URL}/taskState/${taskId}`);
    const taskState = taskStateResp.taskState;

    console.log(`   - usedSubcalls: ${taskState.usedSubcalls}`);
    console.log(`   - spentBudget: ${taskState.spentBudget}`);

    const finalResultText = collectedResults.join(" | ");
    const finalResultHash = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(finalResultText)
    );

    const completionReason = "DeepSeek completed the planned multi-step research task";
    const completionReasonHash = ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(completionReason)
    );

    const completionCert = {
        taskId,
        rootCapId,
        caller: buyerWallet.address,
        spentBudget: taskState.spentBudget,
        usedSubcalls: taskState.usedSubcalls,
        finalResultHash,
        completionReasonHash
    };

    const completionMsgHash = buildCompletionMsgHash(completionCert);
    const completionSignature = await buyerWallet.signMessage(
        ethers.utils.arrayify(completionMsgHash)
    );

    const completeResp = await postJson(`${GATEWAY_BASE_URL}/completeTask`, {
        taskId,
        caller: buyerWallet.address,
        finalResultHash,
        completionReason,
        completionSignature
    });

    console.log("🏁 Completion Certificate 已提交:");
    console.log(`   - ${completeResp.message}`);

    console.log("\n🎉 Buyer Agent 任务结束！");
    console.log("🎯 当前链路：issuer签root -> buyer派生child -> gateway签sigP -> buyer补sigC -> Completion Certificate关闭任务。");
}

main().catch((err) => {
    console.error("❌ ai_agent 执行失败:", err.message);
});