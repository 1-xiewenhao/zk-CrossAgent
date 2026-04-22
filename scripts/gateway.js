require("dotenv").config();

const express = require("express");
const { ethers, artifacts } = require("hardhat");
const cors = require("cors");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const circomlibjs = require("circomlibjs");

const app = express();
app.use(express.json());
app.use(cors());

// ========================================================
// 0. 配置区
// ========================================================
const ALIYUN_API_KEY = process.env.ALIYUN_API_KEY || "";
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || "https://rpc-amoy.polygon.technology";
const CAP_MANAGER_ADDRESS = process.env.CAP_MANAGER_ADDRESS || "";
const GATEWAY_PRIVATE_KEY = process.env.GATEWAY_PRIVATE_KEY || "";
const TRUSTED_ISSUER_ADDRESS = (process.env.TRUSTED_ISSUER_ADDRESS || "").toLowerCase();
const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 3000);

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const BATCH_TIMEOUT_MS = Number(process.env.BATCH_TIMEOUT_MS || 20000);

const PROVIDER_SERVICE_COST = Number(process.env.PROVIDER_SERVICE_COST || 8);
const ORCHESTRATOR_FEE = Number(process.env.ORCHESTRATOR_FEE || 2);

const MANIFEST_DIR = process.env.MANIFEST_DIR || path.join(__dirname, "../manifests");
const COMPLETION_DIR = process.env.COMPLETION_DIR || path.join(MANIFEST_DIR, "completions");

// ======================
// Benchmark 开关
// ======================
const BENCHMARK_MODE = process.env.BENCHMARK_MODE === "true";
const MOCK_LLM_DELAY_MS = Number(process.env.MOCK_LLM_DELAY_MS || 10);
const MOCK_CREDIT_SCORE = Number(process.env.MOCK_CREDIT_SCORE || 100);
const DISABLE_BACKGROUND_PROVING = process.env.DISABLE_BACKGROUND_PROVING === "true";
const QUIET_BENCHMARK_LOGS = process.env.QUIET_BENCHMARK_LOGS !== "false";

// benchmark 模式下关闭高频日志
function benchLog(...args) {
    if (BENCHMARK_MODE && QUIET_BENCHMARK_LOGS) return;
    console.log(...args);
}

const ALLOWED_SCOPES = new Set([
    "PUBLIC_MARKET_DATA",
    "CHAIN_METRICS",
    "PUBLIC_COMPANY_REPORT",
    "PUBLIC_INDUSTRY_RESEARCH"
]);

if (!fs.existsSync(MANIFEST_DIR)) {
    fs.mkdirSync(MANIFEST_DIR, { recursive: true });
}
if (!fs.existsSync(COMPLETION_DIR)) {
    fs.mkdirSync(COMPLETION_DIR, { recursive: true });
}

if (!ALIYUN_API_KEY && !BENCHMARK_MODE) {
    console.warn("⚠️ 未配置 ALIYUN_API_KEY，Qwen 调用将失败。");
}
if (!GATEWAY_PRIVATE_KEY) {
    console.warn("⚠️ 未配置 GATEWAY_PRIVATE_KEY。");
}
if (!TRUSTED_ISSUER_ADDRESS) {
    console.warn("⚠️ 未配置 TRUSTED_ISSUER_ADDRESS。");
}
if (!CAP_MANAGER_ADDRESS) {
    console.warn("⚠️ 未配置 CAP_MANAGER_ADDRESS。");
}

const qwen = new OpenAI({
    apiKey: ALIYUN_API_KEY,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1"
});

// ========================================================
// 1. 全局状态
// ========================================================
let capabilityManager;
let gatewayWallet;
let poseidon;

let batchQueue = [];
let batchTimer = null;
let isProving = false;
let pendingFlushAfterProof = false;
let proofJobCounter = 0;

// replay / budget / pending
const usedRootNonces = new Map();
const usedChildNonces = new Map();
const rootBudgetSpent = new Map();
const childBudgetSpent = new Map();
const pendingReceipts = new Map();
const batchManifests = new Map();

// task state
const taskStates = new Map();

const SNARK_FIELD_SIZE = ethers.BigNumber.from(
    "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

// ========================================================
// 2. 初始化
// ========================================================
async function init() {
    poseidon = await circomlibjs.buildPoseidon();

    const polygonProvider = new ethers.providers.JsonRpcProvider(POLYGON_RPC_URL);
    gatewayWallet = new ethers.Wallet(GATEWAY_PRIVATE_KEY, polygonProvider);

    const CapManagerArtifact = await artifacts.readArtifact("CapabilityManager");
    capabilityManager = new ethers.Contract(
        CAP_MANAGER_ADDRESS,
        CapManagerArtifact.abi,
        gatewayWallet
    );

    console.log(`✅ 网关已挂载 CapabilityManager: ${CAP_MANAGER_ADDRESS}`);
    console.log(`✅ Gateway Provider 地址: ${gatewayWallet.address}`);
    console.log(`🧪 BENCHMARK_MODE=${BENCHMARK_MODE}`);
    console.log(`🧪 DISABLE_BACKGROUND_PROVING=${DISABLE_BACKGROUND_PROVING}`);
    console.log(`🧪 QUIET_BENCHMARK_LOGS=${QUIET_BENCHMARK_LOGS}`);

    try {
        const score = await capabilityManager.getCreditScore(gatewayWallet.address);
        console.log(`✅ 链上联通性检查通过，Gateway 当前信用分读取结果: ${score}`);
    } catch (e) {
        console.warn(`⚠️ CapabilityManager 联通性检查失败: ${e.message}`);
    }

    setInterval(async () => {
        try {
            await flushBatchIfTimeout();
        } catch (e) {
            console.error("❌ Timeout flush 失败:", e.message);
        }
    }, 3000);
}

// ========================================================
// 3. 通用工具函数
// ========================================================
function ensureAllowedScope(scope) {
    return ALLOWED_SCOPES.has(scope);
}

function normalizeCapability(capability) {
    if (!capability) throw new Error("Missing capability");

    const normalized = {
        issuer: ethers.utils.getAddress(capability.issuer),
        holder: ethers.utils.getAddress(capability.holder),
        perms: ethers.BigNumber.from(capability.perms).toString(),
        budget: ethers.BigNumber.from(capability.budget).toString(),
        expiry: Number(capability.expiry),
        parentId: capability.parentId || ethers.constants.HashZero,
        nonce: ethers.BigNumber.from(capability.nonce ?? 0).toString(),
        scopeHash: capability.scopeHash || ethers.constants.HashZero
    };

    normalized.capId = computeCapabilityId(normalized);
    return normalized;
}

function computeCapabilityId(cap) {
    return ethers.utils.solidityKeccak256(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
        [
            cap.issuer,
            cap.holder,
            cap.perms,
            cap.budget,
            cap.expiry,
            cap.parentId,
            cap.nonce,
            cap.scopeHash
        ]
    );
}

function recoverCapabilitySigner(capability, signature) {
    const msgHash = ethers.utils.solidityKeccak256(
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
    return ethers.utils.verifyMessage(ethers.utils.arrayify(msgHash), signature);
}

function computeRequiredScopeHash(requiredScope) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(requiredScope));
}

function computeReqHash(requestPayload) {
    return ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(JSON.stringify(requestPayload))
    );
}

function computeRespHash(reportData) {
    return ethers.utils.keccak256(
        ethers.utils.toUtf8Bytes(reportData)
    );
}

function buildRootNonceKey(rootCapability) {
    return `${rootCapability.issuer.toLowerCase()}:${rootCapability.nonce}`;
}

function buildChildNonceKey(childCapability, caller) {
    return `${ethers.utils.getAddress(caller).toLowerCase()}:${childCapability.nonce}`;
}

function isChildNonceUsed(childCapability, caller) {
    return usedChildNonces.has(buildChildNonceKey(childCapability, caller));
}

function markChildNonceUsed(childCapability, caller) {
    usedChildNonces.set(buildChildNonceKey(childCapability, caller), true);
}

function getRootSpent(rootCapId) {
    return rootBudgetSpent.get(rootCapId) || 0;
}

function getChildSpent(childCapId) {
    return childBudgetSpent.get(childCapId) || 0;
}

function markRootSpent(rootCapId, amount) {
    rootBudgetSpent.set(rootCapId, getRootSpent(rootCapId) + amount);
}

function markChildSpent(childCapId, amount) {
    childBudgetSpent.set(childCapId, getChildSpent(childCapId) + amount);
}

function buildProviderMsgHash(receipt) {
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
            receipt.callId,
            receipt.rootCapId,
            receipt.childCapId,
            receipt.payer,
            receipt.caller,
            receipt.orchestrator,
            receipt.provider,
            receipt.providerAmount,
            receipt.orchestratorFee,
            receipt.timestamp,
            receipt.reqHash,
            receipt.respHash
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

function persistManifest(manifest) {
    const filePath = path.join(MANIFEST_DIR, `${manifest.batchId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
}

function persistCompletionCertificate(taskId, cert) {
    const filePath = path.join(COMPLETION_DIR, `${taskId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(cert, null, 2));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCreditScoreForInvoke(holderAddress) {
    if (BENCHMARK_MODE) {
        return MOCK_CREDIT_SCORE;
    }
    return await checkCreditScore(holderAddress);
}

async function getReportDataForInvoke(operationName) {
    if (BENCHMARK_MODE) {
        await sleep(MOCK_LLM_DELAY_MS);
        return "mocked benchmark response";
    }

    let reportData = "网络波动，千问默认发货";
    try {
        const chatCompletion = await qwen.chat.completions.create({
            model: "qwen-plus",
            messages: [
                {
                    role: "system",
                    content: "你是华尔街顶级数据分析师。请根据客户的需求，提供一句20个字以内的极其专业的公开市场分析结论（可以适度瞎编具体数字，但语气必须专业）。"
                },
                {
                    role: "user",
                    content: operationName
                }
            ]
        });
        reportData = chatCompletion.choices[0].message.content;
    } catch (_) {
        console.log("⚠️ 千问API超载，返回默认数据。");
    }
    return reportData;
}

// ========================================================
// 4. Poseidon / 电路输入映射
// ========================================================
function fieldFromHex32(v) {
    return ethers.BigNumber.from(v).mod(SNARK_FIELD_SIZE).toString();
}

function fieldFromAddress(addr) {
    return ethers.BigNumber.from(addr).toString();
}

function fieldFromUint(v) {
    return ethers.BigNumber.from(v).toString();
}

function poseidonField(inputs) {
    const out = poseidon(inputs.map(x => BigInt(x)));
    return poseidon.F.toString(out);
}

function poseidonFieldToHex(fieldStr) {
    return ethers.utils.hexZeroPad(
        ethers.BigNumber.from(fieldStr).toHexString(),
        32
    );
}

function computeLeafFieldFromItem(item) {
    return poseidonField([
        fieldFromHex32(item.callId),
        fieldFromHex32(item.rootCapId),
        fieldFromHex32(item.childCapId),
        fieldFromHex32(item.taskId),
        fieldFromHex32(item.reqHash),
        fieldFromHex32(item.respHash),
        fieldFromUint(item.timestamp),
        fieldFromUint(item.isDummy ? 1 : 0)
    ]);
}

function computeBatchRootFromItems(items) {
    const leafFields = items.map(item => computeLeafFieldFromItem(item));
    return poseidonFieldToHex(poseidonField(leafFields));
}

function buildCircuitBatchInput(paddedItems) {
    return {
        rootIssuer: paddedItems.map(item =>
            fieldFromAddress(item.rootCapability?.issuer || ethers.constants.AddressZero)
        ),
        rootPerms: paddedItems.map(item =>
            fieldFromUint(item.rootCapability?.perms || 0)
        ),
        rootBudget: paddedItems.map(item =>
            fieldFromUint(item.rootCapability?.budget || 0)
        ),
        rootExpiry: paddedItems.map(item =>
            fieldFromUint(item.rootCapability?.expiry || 0)
        ),
        rootScopeHash: paddedItems.map(item =>
            fieldFromHex32(item.rootCapability?.scopeHash || ethers.constants.HashZero)
        ),
        rootCapId: paddedItems.map(item =>
            fieldFromHex32(item.rootCapId || ethers.constants.HashZero)
        ),

        childIssuer: paddedItems.map(item =>
            fieldFromAddress(item.childCapability?.issuer || ethers.constants.AddressZero)
        ),
        childHolder: paddedItems.map(item =>
            fieldFromAddress(item.childCapability?.holder || ethers.constants.AddressZero)
        ),
        childPerms: paddedItems.map(item =>
            fieldFromUint(item.childCapability?.perms || 0)
        ),
        childBudget: paddedItems.map(item =>
            fieldFromUint(item.childCapability?.budget || 0)
        ),
        childExpiry: paddedItems.map(item =>
            fieldFromUint(item.childCapability?.expiry || 0)
        ),
        childScopeHash: paddedItems.map(item =>
            fieldFromHex32(item.childCapability?.scopeHash || ethers.constants.HashZero)
        ),
        childParentId: paddedItems.map(item =>
            fieldFromHex32(item.childCapability?.parentId || ethers.constants.HashZero)
        ),
        childCapId: paddedItems.map(item =>
            fieldFromHex32(item.childCapId || ethers.constants.HashZero)
        ),

        callId: paddedItems.map(item =>
            fieldFromHex32(item.callId || ethers.constants.HashZero)
        ),
        taskId: paddedItems.map(item =>
            fieldFromHex32(item.taskId || ethers.constants.HashZero)
        ),
        reqHash: paddedItems.map(item =>
            fieldFromHex32(item.reqHash || ethers.constants.HashZero)
        ),
        respHash: paddedItems.map(item =>
            fieldFromHex32(item.respHash || ethers.constants.HashZero)
        ),
        timestamp: paddedItems.map(item =>
            fieldFromUint(item.timestamp || 0)
        ),
        expectedProvider: paddedItems.map(item =>
            fieldFromAddress(item.provider || ethers.constants.AddressZero)
        ),
        isDummy: paddedItems.map(item =>
            fieldFromUint(item.isDummy ? 1 : 0)
        )
    };
}

// ========================================================
// 5. 批处理辅助
// ========================================================
function makeDummyBatchItem(index = 0) {
    return {
        batchItemId: ethers.utils.keccak256(
            ethers.utils.toUtf8Bytes(`dummy-${Date.now()}-${index}`)
        ),
        callId: ethers.constants.HashZero,
        rootCapId: ethers.constants.HashZero,
        childCapId: ethers.constants.HashZero,
        taskId: ethers.constants.HashZero,
        payer: ethers.constants.AddressZero,
        caller: ethers.constants.AddressZero,
        orchestrator: ethers.constants.AddressZero,
        provider: ethers.constants.AddressZero,
        providerAmount: 0,
        orchestratorFee: 0,
        timestamp: 0,
        reqHash: ethers.constants.HashZero,
        respHash: ethers.constants.HashZero,
        sigP: "0x",
        sigC: "0x",
        isDummy: true,
        rootCapability: {
            issuer: ethers.constants.AddressZero,
            holder: ethers.constants.AddressZero,
            perms: "0",
            budget: "0",
            expiry: 0,
            parentId: ethers.constants.HashZero,
            nonce: "0",
            scopeHash: ethers.constants.HashZero,
            capId: ethers.constants.HashZero
        },
        childCapability: {
            issuer: ethers.constants.AddressZero,
            holder: ethers.constants.AddressZero,
            perms: "0",
            budget: "0",
            expiry: 0,
            parentId: ethers.constants.HashZero,
            nonce: "0",
            scopeHash: ethers.constants.HashZero,
            capId: ethers.constants.HashZero
        }
    };
}

function padBatchItemsToFixedSize(batchItems, targetSize = BATCH_SIZE) {
    const padded = [...batchItems];
    let dummyCount = 0;

    while (padded.length < targetSize) {
        padded.push(makeDummyBatchItem(dummyCount));
        dummyCount += 1;
    }

    return {
        paddedItems: padded,
        realCount: batchItems.length,
        dummyCount
    };
}

function startBatchTimerIfNeeded() {
    if (!batchTimer && batchQueue.length > 0) {
        batchTimer = Date.now();
    }
}

function resetBatchTimerIfQueueEmpty() {
    if (batchQueue.length === 0) {
        batchTimer = null;
    }
}

function runSnarkjsFullproveAsync(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        child.on("error", (err) => {
            reject(err);
        });

        child.on("close", (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject(new Error(`snarkjs exited with code ${code}\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`));
            }
        });
    });
}

// ========================================================
// 6. task state
// ========================================================
function getOrInitTaskState(taskMeta, rootCapId, caller) {
    if (!taskMeta) throw new Error("taskMeta is required");
    if (!taskMeta.taskId) throw new Error("taskMeta.taskId is required");

    const taskId = taskMeta.taskId;
    const maxSubcalls = Number(taskMeta.maxSubcalls || 0);
    const deadline = Number(taskMeta.deadline || 0);

    if (maxSubcalls <= 0) {
        throw new Error("taskMeta.maxSubcalls must be > 0");
    }
    if (deadline <= 0) {
        throw new Error("taskMeta.deadline must be valid");
    }

    let state = taskStates.get(taskId);
    if (!state) {
        state = {
            taskId,
            rootCapId,
            caller: ethers.utils.getAddress(caller),
            maxSubcalls,
            deadline,
            usedSubcalls: 0,
            spentBudget: 0,
            closed: false,
            closeReason: "",
            completionCertificate: null
        };
        taskStates.set(taskId, state);
    }

    if (state.rootCapId !== rootCapId) {
        throw new Error("taskId is already bound to another rootCapId");
    }
    if (state.caller.toLowerCase() !== ethers.utils.getAddress(caller).toLowerCase()) {
        throw new Error("taskId caller mismatch");
    }

    return state;
}

function assertTaskOpenForInvoke(taskState) {
    const now = Math.floor(Date.now() / 1000);
    if (taskState.closed) {
        throw new Error("Task already closed");
    }
    if (taskState.deadline <= now) {
        throw new Error("Task deadline reached");
    }
    if (taskState.usedSubcalls >= taskState.maxSubcalls) {
        throw new Error("Task maxSubcalls reached");
    }
}

// ========================================================
// 7. capability chain 验证
// ========================================================
async function validateDelegatedCapabilityChain({
    rootCapability,
    rootSignature,
    childCapability,
    childSignature,
    requestPayload,
    caller
}) {
    if (!rootCapability) throw new Error("rootCapability is required");
    if (!rootSignature) throw new Error("rootSignature is required");
    if (!childCapability) throw new Error("childCapability is required");
    if (!childSignature) throw new Error("childSignature is required");
    if (!requestPayload) throw new Error("requestPayload is required");
    if (!caller) throw new Error("caller is required");

    const normalizedCaller = ethers.utils.getAddress(caller);

    const recoveredRootSigner = recoverCapabilitySigner(rootCapability, rootSignature);
    if (recoveredRootSigner.toLowerCase() !== rootCapability.issuer.toLowerCase()) {
        throw new Error("Invalid root capability signature");
    }

    if (rootCapability.issuer.toLowerCase() !== TRUSTED_ISSUER_ADDRESS) {
        throw new Error("Root issuer is not trusted");
    }

    if (rootCapability.holder.toLowerCase() !== normalizedCaller.toLowerCase()) {
        throw new Error("Root capability holder does not match caller");
    }

    const now = Math.floor(Date.now() / 1000);
    if (rootCapability.expiry <= now) {
        throw new Error("Root capability expired");
    }

    const requiredPerm = Number(requestPayload.requiredPerm || 0);
    const requiredScope = requestPayload.requiredScope;

    if (!requiredScope || !ensureAllowedScope(requiredScope)) {
        throw new Error("Invalid or unsupported requiredScope");
    }

    const requiredScopeHash = computeRequiredScopeHash(requiredScope);
    if (rootCapability.scopeHash.toLowerCase() !== requiredScopeHash.toLowerCase()) {
        throw new Error("Root capability scope mismatch");
    }

    if (ethers.BigNumber.from(rootCapability.perms).lt(requiredPerm)) {
        throw new Error("Insufficient root capability permission");
    }

    const recoveredChildSigner = recoverCapabilitySigner(childCapability, childSignature);
    if (recoveredChildSigner.toLowerCase() !== normalizedCaller.toLowerCase()) {
        throw new Error("Invalid child capability signature");
    }

    if (childCapability.issuer.toLowerCase() !== rootCapability.issuer.toLowerCase()) {
        throw new Error("Child issuer mismatch");
    }

    if (childCapability.parentId.toLowerCase() !== rootCapability.capId.toLowerCase()) {
        throw new Error("Child parentId mismatch");
    }

    if (childCapability.holder.toLowerCase() !== gatewayWallet.address.toLowerCase()) {
        throw new Error("Child capability holder must be gateway/provider");
    }

    if (childCapability.expiry > rootCapability.expiry) {
        throw new Error("Child expiry exceeds root expiry");
    }

    if (ethers.BigNumber.from(childCapability.perms).gt(rootCapability.perms)) {
        throw new Error("Child permission exceeds root permission");
    }

    if (ethers.BigNumber.from(childCapability.budget).gt(rootCapability.budget)) {
        throw new Error("Child budget exceeds root budget");
    }

    if (childCapability.scopeHash.toLowerCase() !== rootCapability.scopeHash.toLowerCase()) {
        throw new Error("Child scope mismatch with root");
    }

    if (childCapability.expiry <= now) {
        throw new Error("Child capability expired");
    }

    if (isChildNonceUsed(childCapability, caller)) {
        throw new Error("Child capability nonce already used");
    }

    const totalCost = PROVIDER_SERVICE_COST + ORCHESTRATOR_FEE;
    const spentRoot = getRootSpent(rootCapability.capId);
    const spentChild = getChildSpent(childCapability.capId);

    if (spentRoot + totalCost > Number(rootCapability.budget)) {
        throw new Error("Insufficient root capability budget");
    }

    if (spentChild + PROVIDER_SERVICE_COST > Number(childCapability.budget)) {
        throw new Error("Insufficient child capability budget");
    }

    return {
        ok: true,
        requiredScopeHash,
        spentRoot,
        spentChild
    };
}

// ========================================================
// 8. 风控
// ========================================================
async function checkCreditScore(holderAddress) {
    const score = await capabilityManager.getCreditScore(holderAddress);
    return Number(score);
}

// ========================================================
// 9. Batch ZKP
// ========================================================
async function triggerBatchZKP(batchItems) {
    if (!batchItems || batchItems.length === 0) return;

    if (isProving) {
        console.log("⏳ [ZKP 引擎] 当前已有证明任务在运行，先标记为待续批处理...");
        pendingFlushAfterProof = true;
        return;
    }

    isProving = true;
    proofJobCounter += 1;
    const jobId = proofJobCounter;

    try {
        const { paddedItems, realCount, dummyCount } = padBatchItemsToFixedSize(batchItems, BATCH_SIZE);

        console.log(`\n🌪️ [ZKP 引擎] 正在将 ${realCount} 笔真实交易 + ${dummyCount} 笔 dummy 交易打包成固定大小证明...`);

        const circuitsDir = path.join(__dirname, "../circuits");

        const inputFile = `batch_input_${jobId}.json`;
        const proofFile = `batch_proof_${jobId}.json`;
        const publicFile = `batch_public_${jobId}.json`;

        const inputPath = path.join(circuitsDir, inputFile);
        const proofPath = path.join(circuitsDir, proofFile);
        const publicPath = path.join(circuitsDir, publicFile);

        const dynamicBatchInput = buildCircuitBatchInput(paddedItems);
        fs.writeFileSync(inputPath, JSON.stringify(dynamicBatchInput, null, 2));

        const expectedBatchRoot = computeBatchRootFromItems(paddedItems);

        const batchId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["bytes32", "uint256", "uint256"],
                [expectedBatchRoot, paddedItems.length, Date.now()]
            )
        );

        const manifest = {
            batchId,
            jobId,
            batchRoot: expectedBatchRoot,
            itemCount: realCount,
            paddedItemCount: paddedItems.length,
            dummyCount,
            createdAt: Date.now(),
            status: "proving",
            items: paddedItems.map(item => ({
                callId: item.callId,
                rootCapId: item.rootCapId,
                childCapId: item.childCapId,
                taskId: item.taskId,
                payer: item.payer,
                caller: item.caller,
                orchestrator: item.orchestrator,
                provider: item.provider,
                providerAmount: item.providerAmount,
                orchestratorFee: item.orchestratorFee,
                timestamp: item.timestamp,
                reqHash: item.reqHash,
                respHash: item.respHash,
                sigP: item.sigP,
                sigC: item.sigC,
                rootCapability: item.rootCapability || null,
                childCapability: item.childCapability || null,
                isDummy: !!item.isDummy
            }))
        };

        batchManifests.set(batchId, manifest);
        persistManifest(manifest);

        console.log("   -> 异步调用 snarkjs 进行高能计算...");

        await runSnarkjsFullproveAsync(
            "npx",
            [
                "snarkjs",
                "groth16",
                "fullprove",
                inputFile,
                "batch_capability_js/batch_capability.wasm",
                "batch_final.zkey",
                proofFile,
                publicFile
            ],
            circuitsDir
        );

        const proof = JSON.parse(fs.readFileSync(proofPath, "utf-8"));
        const publicSignals = JSON.parse(fs.readFileSync(publicPath, "utf-8"));

        const a = [proof.pi_a[0], proof.pi_a[1]];
        const b = [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]]
        ];
        const c = [proof.pi_c[0], proof.pi_c[1]];

        const normalizedBatchRoot = ethers.utils.hexZeroPad(
            ethers.BigNumber.from(publicSignals[0]).toHexString(),
            32
        );

        if (normalizedBatchRoot.toLowerCase() !== expectedBatchRoot.toLowerCase()) {
            throw new Error(
                `Batch root mismatch: expected=${expectedBatchRoot}, actual=${normalizedBatchRoot}`
            );
        }

        manifest.batchRoot = normalizedBatchRoot;
        manifest.status = "submitting";
        batchManifests.set(batchId, manifest);
        persistManifest(manifest);

        console.log(`📦 批次 batchId: ${batchId}`);
        console.log(`📦 真实交易数: ${realCount}`);
        console.log(`📦 dummy 补位数: ${dummyCount}`);
        console.log(`📦 expected batchRoot: ${expectedBatchRoot}`);
        console.log(`📦 规范化 batchRoot(bytes32 hex): ${normalizedBatchRoot}`);
        console.log("🚀 提交 Polygon 上链验证！");

        const tx = await capabilityManager.registerBatchZKP(a, b, c, publicSignals, {
            gasLimit: 350000,
            maxPriorityFeePerGas: ethers.utils.parseUnits("35", "gwei"),
            maxFeePerGas: ethers.utils.parseUnits("40", "gwei")
        });

        await tx.wait();

        manifest.status = "verified_on_polygon";
        batchManifests.set(batchId, manifest);
        persistManifest(manifest);

        console.log("✅ Polygon 批量验证通过！中继器现在可以基于 manifest 做真实结算。");

        try { fs.unlinkSync(inputPath); } catch (_) {}
        try { fs.unlinkSync(proofPath); } catch (_) {}
        try { fs.unlinkSync(publicPath); } catch (_) {}

    } catch (err) {
        console.error("❌ Batch ZKP 异步任务失败:", err.message);
    } finally {
        isProving = false;

        if (pendingFlushAfterProof) {
            pendingFlushAfterProof = false;

            if (batchQueue.length > 0) {
                console.log("🔁 [ZKP 引擎] 检测到证明期间积压了新交易，继续处理下一批...");
                const nextBatch = [...batchQueue];
                batchQueue = [];
                resetBatchTimerIfQueueEmpty();

                if (DISABLE_BACKGROUND_PROVING) {
                    console.log("🧪 [Benchmark] Background proving disabled, queued batch cleared without proving.");
                } else {
                    triggerBatchZKP(nextBatch);
                }
            }
        }
    }
}

async function flushBatchIfReady() {
    if (batchQueue.length < BATCH_SIZE) return;

    const batchToProve = [...batchQueue];
    batchQueue = [];
    resetBatchTimerIfQueueEmpty();

    if (DISABLE_BACKGROUND_PROVING) {
        console.log("🧪 [Benchmark] Background proving disabled, batch cleared without proving.");
        return;
    }

    triggerBatchZKP(batchToProve);
}

async function flushBatchIfTimeout() {
    if (batchQueue.length === 0 || !batchTimer) return;
    const elapsed = Date.now() - batchTimer;
    if (elapsed < BATCH_TIMEOUT_MS) return;

    console.log(`⏰ [活性保障] 批次等待已超过 ${BATCH_TIMEOUT_MS} ms，触发超时强制结算批处理...`);

    const batchToProve = [...batchQueue];
    batchQueue = [];
    resetBatchTimerIfQueueEmpty();

    if (DISABLE_BACKGROUND_PROVING) {
        console.log("🧪 [Benchmark] Background proving disabled, timeout batch cleared without proving.");
        return;
    }

    triggerBatchZKP(batchToProve);
}

// ========================================================
// 10. invoke
// ========================================================
app.post("/invoke", async (req, res) => {
    try {
        const {
            requestPayload,
            caller,
            rootCapability,
            rootSignature,
            childCapability,
            childSignature,
            taskMeta
        } = req.body;

        if (!requestPayload || !caller || !rootCapability || !rootSignature || !childCapability || !childSignature || !taskMeta) {
            return res.status(400).json({
                status: "error",
                error: "Missing requestPayload/caller/rootCapability/rootSignature/childCapability/childSignature/taskMeta"
            });
        }

        const normalizedRoot = normalizeCapability(rootCapability);
        const normalizedChild = normalizeCapability(childCapability);

        await validateDelegatedCapabilityChain({
            rootCapability: normalizedRoot,
            rootSignature,
            childCapability: normalizedChild,
            childSignature,
            requestPayload,
            caller
        });

        const taskState = getOrInitTaskState(taskMeta, normalizedRoot.capId, caller);
        assertTaskOpenForInvoke(taskState);

        const score = await getCreditScoreForInvoke(normalizedRoot.holder);
        benchLog(`\n[风控中心] 买家 ${normalizedRoot.holder} 当前信用分: ${score}${BENCHMARK_MODE ? " (mock)" : ""}`);

        if (score < 60) {
            return res.status(403).json({
                status: "rejected",
                error: "Reputation too low"
            });
        }

        const requestId = ethers.utils.keccak256(
            ethers.utils.defaultAbiCoder.encode(
                ["address", "bytes32", "bytes32", "bytes32", "uint256", "string"],
                [
                    ethers.utils.getAddress(caller),
                    normalizedRoot.capId,
                    normalizedChild.capId,
                    taskMeta.taskId,
                    Date.now(),
                    requestPayload.operationName || ""
                ]
            )
        );

        const callId = requestId;
        const reqHash = computeReqHash(requestPayload);

        benchLog(`[网关接单] taskId=${taskMeta.taskId}, callId=${callId}, scope=${requestPayload.requiredScope}, 需求="${requestPayload.operationName}"`);

        const reportData = await getReportDataForInvoke(requestPayload.operationName);

        const respHash = computeRespHash(reportData);
        const timestamp = Math.floor(Date.now() / 1000);

        const payer = normalizedRoot.issuer;
        const providerAmount = PROVIDER_SERVICE_COST;
        const orchestratorFee = ORCHESTRATOR_FEE;
        const totalAmount = providerAmount + orchestratorFee;

        const providerMsgHash = buildProviderMsgHash({
            callId,
            rootCapId: normalizedRoot.capId,
            childCapId: normalizedChild.capId,
            payer,
            caller: ethers.utils.getAddress(caller),
            orchestrator: ethers.utils.getAddress(caller),
            provider: gatewayWallet.address,
            providerAmount,
            orchestratorFee,
            timestamp,
            reqHash,
            respHash
        });

        const sigP = await gatewayWallet.signMessage(ethers.utils.arrayify(providerMsgHash));

        pendingReceipts.set(callId, {
            taskId: taskMeta.taskId,
            callId,
            rootCapId: normalizedRoot.capId,
            childCapId: normalizedChild.capId,
            payer,
            caller: ethers.utils.getAddress(caller),
            orchestrator: ethers.utils.getAddress(caller),
            provider: gatewayWallet.address,
            providerAmount,
            orchestratorFee,
            totalAmount,
            timestamp,
            reqHash,
            respHash,
            sigP,
            sigC: null,
            rootCapability: normalizedRoot,
            rootSignature,
            childCapability: normalizedChild,
            childSignature,
            requestPayload,
            reportData,
            status: "awaiting_caller_sig"
        });

        markChildNonceUsed(normalizedChild, caller);
        markRootSpent(normalizedRoot.capId, totalAmount);
        markChildSpent(normalizedChild.capId, providerAmount);

        taskState.usedSubcalls += 1;
        taskState.spentBudget += totalAmount;
        taskStates.set(taskMeta.taskId, taskState);

        return res.json({
            status: "success",
            data: reportData,
            taskId: taskMeta.taskId,
            callId,
            rootCapId: normalizedRoot.capId,
            childCapId: normalizedChild.capId,
            provider: gatewayWallet.address,
            providerAmount,
            orchestratorFee,
            totalAmount,
            timestamp,
            reqHash,
            respHash,
            sigP
        });
    } catch (err) {
        console.error("❌ /invoke 失败:", err.message);
        return res.status(400).json({
            status: "error",
            error: err.message
        });
    }
});

// ========================================================
// 11. confirmReceipt
// ========================================================
app.post("/confirmReceipt", async (req, res) => {
    try {
        const { callId, caller, sigC } = req.body;

        if (!callId || !caller || !sigC) {
            return res.status(400).json({
                status: "error",
                error: "Missing callId/caller/sigC"
            });
        }

        const receipt = pendingReceipts.get(callId);
        if (!receipt) {
            return res.status(404).json({
                status: "error",
                error: "Pending receipt not found"
            });
        }

        if (receipt.status !== "awaiting_caller_sig") {
            return res.status(400).json({
                status: "error",
                error: `Receipt status invalid: ${receipt.status}`
            });
        }

        if (receipt.caller.toLowerCase() !== ethers.utils.getAddress(caller).toLowerCase()) {
            return res.status(403).json({
                status: "error",
                error: "Caller does not match pending receipt"
            });
        }

        const providerMsgHash = buildProviderMsgHash(receipt);
        const callerMsgHash = buildCallerMsgHash(providerMsgHash, receipt.sigP);

        const recoveredCaller = ethers.utils.verifyMessage(
            ethers.utils.arrayify(callerMsgHash),
            sigC
        );

        if (recoveredCaller.toLowerCase() !== receipt.caller.toLowerCase()) {
            return res.status(400).json({
                status: "error",
                error: "Invalid caller signature"
            });
        }

        receipt.sigC = sigC;
        receipt.status = "ready_for_batch";
        pendingReceipts.set(callId, receipt);

        const batchItem = {
            batchItemId: ethers.utils.keccak256(
                ethers.utils.defaultAbiCoder.encode(
                    ["bytes32", "bytes32", "bytes32", "uint256"],
                    [receipt.callId, receipt.rootCapId, receipt.childCapId, receipt.timestamp]
                )
            ),
            taskId: receipt.taskId,
            callId: receipt.callId,
            rootCapId: receipt.rootCapId,
            childCapId: receipt.childCapId,
            payer: receipt.payer,
            caller: receipt.caller,
            orchestrator: receipt.orchestrator,
            provider: receipt.provider,
            providerAmount: receipt.providerAmount,
            orchestratorFee: receipt.orchestratorFee,
            timestamp: receipt.timestamp,
            reqHash: receipt.reqHash,
            respHash: receipt.respHash,
            sigP: receipt.sigP,
            sigC: receipt.sigC,
            rootCapability: receipt.rootCapability,
            childCapability: receipt.childCapability,
            isDummy: false
        };

        batchQueue.push(batchItem);
        startBatchTimerIfNeeded();

        benchLog(`[回执确认] taskId=${receipt.taskId}, callId=${callId} 已完成双签，进入批处理队列。当前 ${batchQueue.length}/${BATCH_SIZE}`);

        await flushBatchIfReady();

        return res.json({
            status: "success",
            message: "Receipt confirmed and queued for settlement batch",
            queueLength: batchQueue.length
        });
    } catch (err) {
        console.error("❌ /confirmReceipt 失败:", err.message);
        return res.status(400).json({
            status: "error",
            error: err.message
        });
    }
});

// ========================================================
// 12. taskState
// ========================================================
app.get("/taskState/:taskId", async (req, res) => {
    try {
        const { taskId } = req.params;
        const state = taskStates.get(taskId);

        if (!state) {
            return res.status(404).json({
                status: "error",
                error: "Task not found"
            });
        }

        return res.json({
            status: "success",
            taskState: state
        });
    } catch (err) {
        console.error("❌ /taskState 查询失败:", err.message);
        return res.status(400).json({
            status: "error",
            error: err.message
        });
    }
});

// ========================================================
// 13. completeTask
// ========================================================
app.post("/completeTask", async (req, res) => {
    try {
        const {
            taskId,
            caller,
            finalResultHash,
            completionReason,
            completionSignature
        } = req.body;

        if (!taskId || !caller || !finalResultHash || !completionReason || !completionSignature) {
            return res.status(400).json({
                status: "error",
                error: "Missing taskId/caller/finalResultHash/completionReason/completionSignature"
            });
        }

        const state = taskStates.get(taskId);
        if (!state) {
            return res.status(404).json({
                status: "error",
                error: "Task not found"
            });
        }

        if (state.closed) {
            return res.status(400).json({
                status: "error",
                error: "Task already closed"
            });
        }

        if (state.caller.toLowerCase() !== ethers.utils.getAddress(caller).toLowerCase()) {
            return res.status(403).json({
                status: "error",
                error: "Caller mismatch"
            });
        }

        const completionReasonHash = ethers.utils.keccak256(
            ethers.utils.toUtf8Bytes(completionReason)
        );

        const cert = {
            taskId,
            rootCapId: state.rootCapId,
            caller: ethers.utils.getAddress(caller),
            spentBudget: state.spentBudget,
            usedSubcalls: state.usedSubcalls,
            finalResultHash,
            completionReasonHash
        };

        const completionMsgHash = buildCompletionMsgHash(cert);
        const recovered = ethers.utils.verifyMessage(
            ethers.utils.arrayify(completionMsgHash),
            completionSignature
        );

        if (recovered.toLowerCase() !== state.caller.toLowerCase()) {
            return res.status(400).json({
                status: "error",
                error: "Invalid completion certificate signature"
            });
        }

        state.closed = true;
        state.closeReason = completionReason;
        state.completionCertificate = {
            ...cert,
            completionReason,
            completionSignature,
            closedAt: Date.now()
        };
        taskStates.set(taskId, state);

        persistCompletionCertificate(taskId, state.completionCertificate);

        console.log(`🏁 [任务关闭] taskId=${taskId}, spent=${state.spentBudget}, subcalls=${state.usedSubcalls}`);

        return res.json({
            status: "success",
            message: "Task closed with completion certificate",
            certificate: state.completionCertificate
        });
    } catch (err) {
        console.error("❌ /completeTask 失败:", err.message);
        return res.status(400).json({
            status: "error",
            error: err.message
        });
    }
});

// ========================================================
// 14. 启动
// ========================================================
init().then(() => {
    app.listen(GATEWAY_PORT, () => {
        console.log(`\n🚀 zk-CrossAgent Gateway 已启动 (Port:${GATEWAY_PORT})`);
    });
}).catch((e) => {
    console.error("❌ Gateway 初始化失败:", e.message);
});